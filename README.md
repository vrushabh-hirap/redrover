# RedRover — Solar System Explorer and AI Mission Planner

An interactive, browser-based 3D atlas of the whole Solar System, a mission
planner that compares classical graph-search algorithms on a documented mission
graph, and a separate time-evolving Earth-orbit traffic simulation with D\* Lite
incremental replanning.

> [!IMPORTANT]
> **Educational simulation.** Planetary positions come from NASA/JPL Horizons
> ephemerides; Earth-orbit objects come from the CelesTrak General Perturbations
> catalog (US Space Force / Space-Track). Route plans are conceptual AI graph
> searches — not spacecraft trajectories, not validated Δv budgets, and not
> conjunction assessments. See [`DATA_SOURCES.md`](DATA_SOURCES.md) for the full
> provenance record.

---

## 1. Modes

| Mode | What it does |
|---|---|
| **Explorer** | Navigate the whole Solar System, inspect bodies, moons and cataloged objects. Two labelled scale modes: *Solar System Overview* (log-compressed distances, enlarged bodies) and *Focus* (true local scale). |
| **Mission Planner** | Pick an origin on Earth (click the globe or choose a launch site), pick a destination, choose one of BFS / DFS / UCS / Greedy / A\* and a cost model, then plan and compare routes on the documented mission graph. |
| **Orbital Traffic · D\* Lite** | The moving-object experiment: cataloged Earth-orbit objects propagate with SGP4 while D\* Lite repairs a route through a time-expanded occupancy grid. Start / pause / step / reset / replay. |

The modes are independent: the D\* experiment never runs as part of the static
algorithm comparison, and the Solar-System clock animation is separate from the
traffic simulation.

---

## 2. Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

```bash
npm run build        # type-check + production build into dist/
npm run preview      # serve the production build
npx vitest run       # 50 unit tests
npm run lint          # oxlint
```

Regenerate the bundled datasets (optional — bundled data ships with the repo):

```bash
node preprocessing/fetch_horizons.js     # JPL Horizons vectors
node preprocessing/fetch_catalog.js      # CelesTrak GP catalog
```

Requires Node 18+ and a WebGL 2 browser. No API keys, no secret credentials.

---

## 3. Architecture

```
src/
  App.tsx                mode shell, search, mission flow, traffic loop
  styles.css             the whole design system (tokens + components)
  data/
    horizons.ts          JPL Horizons live + bundled snapshot access
    celestrak.ts         CelesTrak live + bundled groups, provenance
    ommToTle.ts          OMM → check-summed TLE conversion
    sgp4Client.ts        main-thread client for the SGP4 worker
    types.ts             catalog object, vector and region types
    common.ts            shared cache helpers
  orbit/sgp4.ts          SGP4 propagation and classical orbit helpers
  core/missionGraph.ts   the documented mission navigation graph + heuristic
  planners/
    staticPlanners.ts    BFS, DFS, UCS, Greedy, A* over that graph
    dStarLite.ts         D* Lite on a time-expanded occupancy grid
  scene/
    SolarScene.ts        one renderer, one loop, both scale modes, picking
    scale.ts             km ↔ scene-unit mappings, orbit geometry, filters
  ui/                    TopBar, LeftPanel, Inspector, TimeBar, DataPanel, common
  workers/sgp4.worker.ts batch propagation off the main thread
public/data/
  ephemeris/             bundled JPL Horizons vector snapshot + manifest
  catalog/               bundled CelesTrak GP groups + manifest
```

### Rendering and performance

- **One** `requestAnimationFrame` loop and **one** WebGL renderer for all modes.
- React state is never written from the render loop; label positions are
  published on a ~12 Hz throttle.
- Catalog objects are a single `Points` draw call; positions are refreshed only
  when the epoch or the filter set changes, not every frame.
- Body meshes, orbit lines, moon systems, satellite markers and route overlays
  are separate scene layers that can be toggled independently.
- Bodies far outside the view frustum are culled so the far plane never clips
  the scene; a logarithmic depth buffer handles the enormous range (Earth-orbit
  km through 30 AU).
- Catalog parsing and batch SGP4 propagation run in a Web Worker
  (`src/workers/sgp4.worker.ts`) with a main-thread fallback.
- The camera rig is eased with damping; a fly-to converges even when the tab is
  hidden (the loop can be stepped explicitly).

---

## 4. Scale modes — why the view is not to scale

The real Solar System spans 30 AU while Earth's satellites sit within 0.015 AU
of the planet. No single linear view can show both, so the app uses two named,
labelled modes and never pretends otherwise:

| Mode | Mapping |
|---|---|
| **Solar System Overview** | Heliocentric distance `r` maps to `R₀·log₁₀(1 + r/R₀)` with `R₀ = 0.02 AU`. Direction is preserved exactly, so planets appear at their true ecliptic longitudes. Body meshes are enlarged so they stay selectable, and the exaggeration factor for the focused body is reported in the UI. |
| **Focus** | A true linear local scale centred on one body: one body radius = 300 scene units. The Moon is exactly 60.3 Earth radii from Earth. |

The persistent scale badge under the top bar always states which mode is active
and whether distances are to scale. A planet close-up frames the body itself;
moon systems are 60+ body radii across, so use **Earth–Moon system** /
**Jovian system**, or scroll out, to see a planet together with its moons.

---

## 5. Search algorithms

All five course algorithms are selectable and comparable over the same graph
instance:

| Algorithm | Guarantee | Notes |
|---|---|---|
| BFS | Optimal only for equal edge costs | Minimises transfer stages |
| DFS | None | Traversal baseline |
| UCS | Optimal for non-negative costs | Cheapest route for the cost model |
| Greedy Best-First | None | Heuristic-only ordering |
| A\* | Optimal and efficient with an admissible, consistent `h` | `h` is built from a two-body Δv lower bound plus a speed-capped time bound |

The route inspector reports path cost, Δv proxy, duration, stage count, expanded
nodes, peak frontier, planning time, minimum miss distance, the optimality
qualification and the exact graph version. Every result is tagged
**conceptual AI graph route**.

### D\* Lite (dynamic mode only)

D\* Lite runs on a time-expanded occupancy grid (9 × 20 × 7 cells × 20 steps of
300 s). Edge costs depend on the *arrival* time step, so the same pair of cells
has a different cost at different times. Each tick re-propagates the occupancy
model, applies the changed cell costs to the affected edges, and repairs the
route incrementally — reporting changed cells, expansions during the repair, the
route cost and the replan count. Replays restore the snapshot, the epoch and the
PRNG seed and are deterministic.

---

## 6. Data provenance

The top bar carries a status badge; **Data sources & epoch** opens the full
record. Every block states provider, retrieval time, coverage, frame, units and
whether the layer is live, a bundled snapshot, unavailable or synthetic.

Highlights:

- Positions are JPL Horizons vector ephemerides (`ICRF/J2000` ecliptic,
  heliocentric, km) either queried live for the requested epoch or read from a
  6-hour snapshot covering 2026-09-15 → 2026-12-15.
- Earth-orbit objects are CelesTrak GP records (USSF / Space-Track), converted
  from OMM to check-summed TLEs and propagated with SGP4. The default group
  loads **371 tracked objects**; the group panel shows loaded / visible /
  hidden counts and lets you change type, orbital-region and name filters.
- Requesting an epoch outside snapshot coverage produces a visible warning and
  an offer to query live. The same applies when the requested epoch is more than
  seven days from an element epoch.
- Untracked small debris (NASA ODPO) is explicitly *not* integrated and is
  labelled as such. There is no automatic synthetic fallback.

---

## 7. Tests

```bash
npx vitest run        # 5 files, 50 tests
```

| Suite | Covers |
|---|---|
| `tests/catalogData.test.ts` | OMM → TLE conversion against CelesTrak's own TLE output, checksums, epoch handling, classification, every bundled group converts and propagates |
| `tests/horizonsData.test.ts` | Horizon snapshot schema, physically plausible heliocentric distances, real Earth–Moon distance, moon parentage, interpolation error, coverage flags, region classification |
| `tests/missionGraph.test.ts` | Graph construction, cost-model separation, keep-out blocking, all five algorithms, optimality/admissibility, unreachable destinations |
| `tests/dStarLite.test.ts` | Grid helpers, initial planning, incremental repair, no-op ticks, deterministic snapshot restore, time-dependence of costs |
| `tests/propagationAndScale.test.ts` | Real ISS SGP4 state, agreement with satellite.js, orbital periods, Hohmann values, overview/focus scale mappings, TEME→ECI rotation, filters |

---

## 8. Screenshots

| File | View |
|---|---|
| `docs/screenshots/00_full_ui_desktop.png` | Full application at desktop size |
| `docs/screenshots/01_solar_system_overview.png` | Solar System Overview with all 15 bodies and labels |
| `docs/screenshots/02_earth_moon_system.png` | Earth–Moon system framing |
| `docs/screenshots/03_moon_focus.png` | Moon focus with Earth in the distance |
| `docs/screenshots/04_earth_focus_catalog.png` | Earth focus with 371 cataloged objects |
| `docs/screenshots/06_orbital_traffic_dstar.png` | Orbital traffic with the D\* Lite route and event log |
| `docs/screenshots/07_mission_planner.png` | Mission Planner with a planned route |

`docs/END_TO_END_AUDIT.md` records how each view was produced and what was
verified.

---

## 9. Known limitations

- **No photographic surface imagery.** Bodies are procedurally coloured; no
  NASA/PDS texture tiles are fetched, so terrain detail is not accurate.
- **Orbit rings** are drawn from JPL's approximate Keplerian elements, not from
  the Horizons vectors (positions still come from Horizons).
- **Live Horizons queries** issue one request per body (the API has no
  multi-object call), so a live refresh of 15 bodies takes several seconds and
  may partially fail; failures fall back per body.
- **Live CelesTrak groups** `active` and `starlink` are not bundled and require a
  network round-trip; CelesTrak rate-limits aggressively.
- **The D\* occupancy model** uses at most the first 400 objects of the loaded
  snapshot and 90 km keep-out cells; it is not a conjunction assessment.
- **Manoeuvring objects** in the traffic simulation are a seeded perturbation of
  catalog objects, not observed manoeuvres.
- **The mission graph** is an abstraction with fixed constants for ascent,
  injection, capture and rendezvous. It is not an optimiser.
