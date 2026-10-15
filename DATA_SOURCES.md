# RedRover — Data Sources, Provenance and Limitations

**Last updated:** 2026-10-14
**App version:** 2.0 (Solar System Explorer, Mission Planner, Orbital Traffic)

Every layer of the scene is described here with its provider, the moment it was
retrieved, the epochs it covers, the frame and units it uses, and whether it is
observed, propagated, estimated or synthetic. The same information is available
in the running app via **Data sources & epoch** in the top bar.

---

## 1. Solar-system body positions — NASA/JPL Horizons System

| Field | Value |
|---|---|
| Provider | NASA/JPL Horizons System (vector ephemerides) |
| API | <https://ssd-api.jpl.nasa.gov/doc/horizons.html> |
| System | <https://ssd.jpl.nasa.gov/horizons/> |
| Coordinate frame | ICRF/J2000 with the ecliptic reference plane (`REF_PLANE=ECLIPTIC`) |
| Origin | Heliocentric for the Sun and the eight planets; moons are queried relative to their planet (`CENTER=500@<planet>`) and offset to heliocentric |
| Units | kilometres (position), km/s (velocity) — `OUT_UNITS=KM-S` |
| Bodies | Sun, Mercury, Venus, Earth, Moon, Mars, Jupiter, Io, Europa, Ganymede, Callisto, Saturn, Titan, Uranus, Neptune |
| Retrieval | 2026-10-14T19:33:13Z |
| Coverage | 2026-09-15T00:00Z → 2026-12-15T00:00Z, sampled every 6 hours (365 steps per body) |
| Interpolation | Cubic Hermite between sampled steps using the sampled velocities |

### How the data reaches the browser

1. `preprocessing/fetch_horizons.js` queried the live Horizons API once per body
   and wrote the compact snapshot to `public/data/ephemeris/snapshot.json`
   together with `public/data/ephemeris/manifest.json`.
2. The app loads that snapshot at startup (`HorizonsEphemeris.loadBundled()`),
   so the explorer works offline and deterministically.
3. **Refresh live** in the Data panel re-queries Horizons for the requested
   epoch, caches the answer for one hour, and falls back to the bundled value
   for any body that cannot be refreshed. The status badge reports which mode
   is active: `LIVE` or `CACHED SNAPSHOT`.

### Accuracy note

Positions are exact at the sampled steps. Between steps, Hermite interpolation
was validated against a live Horizons query at 2026-10-01T03:00Z:

| Body | Interpolation error |
|---|---|
| Mercury | 0.0 km |
| Moon | 0.0 km |
| Earth | ~344 km (2.3 × 10⁻⁶ of the heliocentric distance) |
| Io | ~675 km (1.6 × 10⁻³ of the Io–Jupiter distance) |

Requesting an epoch outside the snapshot coverage is reported as such: the app
clamps to the nearest sampled step, shows a warning in the Data panel, and
offers the live query instead of silently presenting stale numbers.

### Orbit lines

Planet orbit rings are **not** the Horizons vectors. They are drawn from JPL's
"Keplerian Elements for Approximate Positions of the Major Planets" (E. M.
Standish), propagated linearly in time and solved with Kepler's equation. Body
positions always come from Horizons; only the drawn rings use the approximate
elements.

---

## 2. Earth-orbit catalog — CelesTrak General Perturbations data

| Field | Value |
|---|---|
| Provider | **CelesTrak** — <https://celestrak.org> |
| Underlying provider | US Space Force / Space-Track General Perturbations catalog |
| Format | OMM JSON |
| Format docs | <https://celestrak.org/NORAD/documentation/gp-data-formats.php> |
| Coordinate frame | TEME (True Equator, Mean Equinox) — the SGP4 output frame |
| Propagator | SGP4 via `satellite.js` v7 |
| Retrieval | 2026-10-14T19:44Z (see `public/data/catalog/manifest.json`) |
| Element epochs | per object, 2026-09-15 → 2026-10-14 depending on the group |

> **This is not NASA data.** It is republished US Space Force / Space-Track
> material served by CelesTrak. The UI states the actual provider everywhere it
> is shown.

### Bundled groups (shipped in `public/data/catalog/`)

| Group | Objects | What it is |
|---|---|---|
| `stations` | 21 | Crewed and cargo stations and visiting vehicles |
| `last-30-days` | 244 | Objects launched in the previous 30 days |
| `iridium-33-debris` | 109 | Tracked fragments of the 2009 Iridium 33 / Cosmos 2251 collision |
| `cosmos-2251-debris` | 588 | Tracked fragments of the same collision |
| `fengyun-1c-debris` | 1,981 | Tracked fragments of the 2007 Fengyun-1C breakup |

Two **pseudo-groups** merge several files, de-duplicated by NORAD id:

- `traffic-mix` (default) — `stations` + `last-30-days` + `iridium-33-debris` = **371 objects**
- `debris-mix` — all three break-up groups = **2,678 objects**

`active` (~9,000 payloads) and `starlink` (~9,000) are live-only groups: they are
not bundled because of their size, and selecting them always issues a live query.

### OMM → TLE conversion

CelesTrak publishes OMM JSON; SGP4 propagators consume two-line element sets.
`src/data/ommToTle.ts` converts the elements with the documented field mapping
and writes check-summed 69-character lines. The conversion was validated against
the TLE text CelesTrak serves for the same group: the worst position difference
after SGP4 propagation is **0.01 km**. A unit test asserts this.

### Object type classification

The GP/JSON format does **not** publish a per-object type field. Types are
therefore derived from the requesting group and the object name (fragments of a
break-up group are debris, the parent object is a payload, `R/B` names are rocket
bodies). This heuristic is documented in the code and in the Catalog panel.

### Propagation limits

SGP4 is accurate to roughly ±7 days of an element epoch. The app computes the
distance between the requested epoch and the newest element epoch and shows a
warning whenever it exceeds that. Positions are estimates of *tracked* objects
only.

---

## 3. Untracked small debris — NASA ODPO

| Field | Value |
|---|---|
| Status | **Not integrated** |
| Reference | <https://orbitaldebris.jsc.nasa.gov/modeling/ordem.html> |
| FAQ | <https://orbitaldebris.jsc.nasa.gov/faq/> |
| Reason | ORDEM is distributed as software, not a public real-time API, and no public per-object position data exists for uncataloged fragments |

Consequences, stated in the app:

1. Only tracked catalog objects are rendered, with truthful loaded / visible /
   hidden counts.
2. No statistical debris-density layer is rendered; if one is added it must be
   labelled as a model, not as tracked objects.
3. The app never advertises "all objects in space" or "complete real-time debris".

---

## 4. Synthetic data

There is **no** automatic synthetic fallback. If neither a live query nor a
bundled snapshot can be loaded, the app shows an `unavailable` state and keeps
the previous dataset with an explanation. The Data panel carries an explicit
`Synthetic fallback — never used automatically` entry so the policy is visible.

---

## 5. Mission navigation graph and D* Lite

Both planners run on an **abstract, documented** graph. Neither is a trajectory
optimiser.

| Field | Value |
|---|---|
| Node kinds | surface launch site, circular parking shell (250/400/800/1200/2000 km), natural moon, planet, cataloged Earth-orbit object |
| Edge costs | Δv proxy (Hohmann two-body for shell changes; fixed constants for ascent, translunar/trans-planet injection, capture, rendezvous), duration, and a keep-out risk penalty |
| Cost models | `fuel`, `time`, `risk`, `balanced` (weights printed in the route inspector) |
| Heuristic | `h(n) = Σᵢ wᵢ·lbᵢ(n)` where the Δv lower bound is `|v_circ(rₙ) − v_circ(r_goal)|·1000` and the time lower bound is distance / 45 km/s |
| Versioning | every graph build records `origin`, `destination`, cost model, keep-out radius and hazard sample size, and the version is shown with each result |

The D* experiment uses a **time-expanded occupancy grid**
(9 altitude bands × 20 azimuth sectors × 7 polar sectors × 20 time steps of 300 s)
whose edge costs depend on the arrival time step. Occupancy comes from
SGP4-propagated catalogued objects (capped at the first 400 of the loaded
snapshot) inflated by a 90 km keep-out radius. A seeded subset of up to four
objects is perturbed each step to represent manoeuvring objects; the same seed
and the same snapshot reproduce the same run.

Both planners are labelled in the UI as *conceptual AI graph routes*. Neither is
a certified trajectory, a validated Δv budget, or a conjunction assessment.

---

## 6. Surface imagery and terrain

No planetary textures or terrain maps are fetched. Every body is rendered with
procedural colour and lighting, so the app never implies photographic accuracy
and never blocks navigation on image downloads.

---

## 7. Reproducing the bundled datasets

```bash
node preprocessing/fetch_horizons.js            # Horizons vectors → public/data/ephemeris/
node preprocessing/fetch_catalog.js             # CelesTrak GP groups → public/data/catalog/
```

Both scripts write a `manifest.json` with the retrieval timestamp, the
requested range and the per-group counts, so a demo can be replayed against the
same records.

---

## 8. Reference links

- JPL Horizons API: <https://ssd-api.jpl.nasa.gov/doc/horizons.html>
- JPL Horizons: <https://ssd.jpl.nasa.gov/horizons/>
- JPL planetary orbits and ephemerides: <https://ssd.jpl.nasa.gov/planets/orbits.html>
- CelesTrak GP data formats: <https://celestrak.org/NORAD/documentation/gp-data-formats.php>
- NASA ODPO ORDEM: <https://orbitaldebris.jsc.nasa.gov/modeling/ordem.html>
- NASA ODPO FAQ: <https://orbitaldebris.jsc.nasa.gov/faq/>
- satellite.js: <https://github.com/shashwatak/satellite-js>

---

*Educational simulation. Nothing here is a certified spacecraft trajectory, a
conjunction assessment, or a complete debris environment.*
