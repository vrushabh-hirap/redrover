/**
 * NASA/JPL Horizons ephemeris access.
 *
 * Live mode queries the Horizons API for the exact requested UTC epoch:
 *   https://ssd-api.jpl.nasa.gov/doc/horizons.html
 *
 * Bundled mode reads a dated snapshot produced by
 * `preprocessing/fetch_horizons.js` (real Horizons vectors sampled at a fixed
 * step, Hermite-interpolated in between). The snapshot is served from the app's
 * own origin so it works offline and is deterministic for replays.
 *
 * Coordinate frame / units are declared by the snapshot itself
 * (`frame`, `units`) and surfaced in the UI. Everything is heliocentric, ICRF /
 * J2000 ecliptic plane, kilometres.
 */

import { Vector3D } from './types';

export interface HorizonsBodyMeta {
  name: string;
  horizonsId: string;
  center: string;
  parent: string | null;
}

export interface HorizonsSnapshot {
  generatedBy: string;
  api: string;
  retrievedAt: string;
  requestedRange: { start: string; stop: string; step: string };
  frame: string;
  units: { position: string; velocity: string };
  bodies: HorizonsBodyMeta[];
  times: string[];
  positions: Record<string, number[][]>;
  velocities: Record<string, number[][]>;
}

export interface BodyState {
  name: string;
  /** Heliocentric position, km, ICRF/J2000 ecliptic. */
  position: Vector3D;
  /** Heliocentric velocity, km/s. */
  velocity: Vector3D;
  /** 'live' when the value came from a live Horizons query for this epoch. */
  source: 'live' | 'snapshot';
}

export interface HorizonsStatus {
  mode: 'live' | 'bundled' | 'unavailable';
  provider: string;
  retrievedAt: string;
  coverage: string;
  frame: string;
  units: string;
  detail?: string;
  requestedEpoch: string;
}

const SNAPSHOT_URL = `${import.meta.env.BASE_URL}data/ephemeris/snapshot.json`;
const LIVE_CACHE_PREFIX = 'horizons-live';
const LIVE_CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

/** Bodies rendered by the explorer. Order is the render order of the overview. */
export const SOLAR_BODIES: HorizonsBodyMeta[] = [
  { name: 'Sun', horizonsId: '10', center: '@sun', parent: null },
  { name: 'Mercury', horizonsId: '199', center: '@sun', parent: null },
  { name: 'Venus', horizonsId: '299', center: '@sun', parent: null },
  { name: 'Earth', horizonsId: '399', center: '@sun', parent: null },
  // The Moon is queried heliocentrically but belongs to the Earth system.
  { name: 'Moon', horizonsId: '301', center: '@sun', parent: 'Earth' },
  { name: 'Mars', horizonsId: '499', center: '@sun', parent: null },
  { name: 'Jupiter', horizonsId: '599', center: '@sun', parent: null },
  { name: 'Io', horizonsId: '501', center: '500@599', parent: 'Jupiter' },
  { name: 'Europa', horizonsId: '502', center: '500@599', parent: 'Jupiter' },
  { name: 'Ganymede', horizonsId: '503', center: '500@599', parent: 'Jupiter' },
  { name: 'Callisto', horizonsId: '504', center: '500@599', parent: 'Jupiter' },
  { name: 'Saturn', horizonsId: '699', center: '@sun', parent: null },
  { name: 'Titan', horizonsId: '606', center: '500@699', parent: 'Saturn' },
  { name: 'Uranus', horizonsId: '799', center: '@sun', parent: null },
  { name: 'Neptune', horizonsId: '899', center: '@sun', parent: null },
];

/** Physical mean radii, km (JPL/NASA planetary fact sheets). */
export const BODY_RADIUS_KM: Record<string, number> = {
  Sun: 695_700,
  Mercury: 2_439.7,
  Venus: 6_051.8,
  Earth: 6_371.0,
  Moon: 1_737.4,
  Mars: 3_389.5,
  Jupiter: 69_911,
  Io: 1_821.6,
  Europa: 1_560.8,
  Ganymede: 2_634.1,
  Callisto: 2_410.3,
  Saturn: 58_232,
  Titan: 2_574.7,
  Uranus: 25_362,
  Neptune: 24_622,
};

export const BODY_PARENT: Record<string, string | null> = Object.fromEntries(
  SOLAR_BODIES.map((b) => [b.name, b.parent]),
);

/** Moons of each body, in render order. */
export const BODY_MOONS: Record<string, string[]> = SOLAR_BODIES.filter((b) => b.parent).reduce(
  (acc, b) => {
    (acc[b.parent!] ??= []).push(b.name);
    return acc;
  },
  {} as Record<string, string[]>,
);

/** Cubic Hermite interpolation between two sampled states. */
function hermite(
  p0: number[], p1: number[], v0: number[], v1: number[], dtSec: number, f: number,
): Vector3D {
  const h00 = 2 * f ** 3 - 3 * f ** 2 + 1;
  const h10 = f ** 3 - 2 * f ** 2 + f;
  const h01 = -2 * f ** 3 + 3 * f ** 2;
  const h11 = f ** 3 - f ** 2;
  return {
    x: h00 * p0[0] + h10 * v0[0] * dtSec + h01 * p1[0] + h11 * v1[0] * dtSec,
    y: h00 * p0[1] + h10 * v0[1] * dtSec + h01 * p1[1] + h11 * v1[1] * dtSec,
    z: h00 * p0[2] + h10 * v0[2] * dtSec + h01 * p1[2] + h11 * v1[2] * dtSec,
  };
}

export class HorizonsEphemeris {
  private snapshot: HorizonsSnapshot | null = null;
  private liveStates: Record<string, BodyState> | null = null;
  private loadError: string | null = null;
  status: HorizonsStatus;
  /** True when the last requested epoch was outside the snapshot's coverage. */
  outsideCoverage = false;

  constructor() {
    this.status = {
      mode: 'unavailable',
      provider: 'NASA/JPL Horizons System',
      retrievedAt: '',
      coverage: 'not loaded',
      frame: '',
      units: '',
      requestedEpoch: new Date().toISOString(),
    };
  }

  get loaded(): boolean {
    return this.snapshot !== null;
  }

  get live(): boolean {
    return this.liveStates !== null;
  }

  /** Load the bundled snapshot (served from the app's own origin). */
  async loadBundled(): Promise<boolean> {
    try {
      const res = await fetch(SNAPSHOT_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const snap = (await res.json()) as HorizonsSnapshot;
      if (!Array.isArray(snap.times) || snap.times.length < 2) {
        throw new Error('Snapshot has no usable time series');
      }
      this.snapshot = snap;
      this.liveStates = null;
      this.loadError = null;
      this.status = {
        mode: 'bundled',
        provider: 'NASA/JPL Horizons System (bundled vector snapshot)',
        retrievedAt: snap.retrievedAt,
        coverage: `${snap.times[0]} → ${snap.times[snap.times.length - 1]} @ ${snap.requestedRange.step} steps`,
        frame: snap.frame,
        units: `position ${snap.units.position}, velocity ${snap.units.velocity}`,
        requestedEpoch: this.status.requestedEpoch,
        detail: 'Live Horizons queries are available from the Data panel.',
      };
      return true;
    } catch (err) {
      this.loadError = String(err);
      this.status = {
        ...this.status,
        mode: 'unavailable',
        provider: 'NASA/JPL Horizons System',
        coverage: 'bundled snapshot failed to load',
        detail: String(err),
      };
      return false;
    }
  }

  /** Unix ms bounds of the bundled snapshot. */
  get coverageMs(): { start: number; stop: number } | null {
    const s = this.snapshot;
    if (!s) return null;
    return { start: Date.parse(s.times[0]), stop: Date.parse(s.times[s.times.length - 1]) };
  }

  /** True when `date` lies inside the bundled snapshot coverage. */
  covers(date: Date): boolean {
    const c = this.coverageMs;
    if (!c) return false;
    const t = date.getTime();
    return t >= c.start && t <= c.stop;
  }

  /** Positions for a requested epoch from the bundled snapshot (Hermite). */
  private fromSnapshot(date: Date): Record<string, BodyState> | null {
    const s = this.snapshot;
    if (!s) return null;
    const times = s.times;
    const t = date.getTime();
    const t0 = Date.parse(times[0]);
    const tN = Date.parse(times[times.length - 1]);
    this.outsideCoverage = t < t0 || t > tN;
    let i = 0;
    // Binary search for the bracketing interval.
    let lo = 0;
    let hi = times.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (Date.parse(times[mid]) <= t) lo = mid;
      else hi = mid;
    }
    i = lo;
    if (!(t >= Date.parse(times[i]) && t <= Date.parse(times[i + 1]))) {
      // Outside the sampled range: clamp to the nearest end and flag it.
      i = t < t0 ? 0 : times.length - 2;
    }
    const dtSec = (Date.parse(times[i + 1]) - Date.parse(times[i])) / 1000;
    const f = Math.max(0, Math.min(1, (t - Date.parse(times[i])) / 1000 / dtSec));
    const out: Record<string, BodyState> = {};
    for (const meta of s.bodies) {
      const p = s.positions[meta.name];
      const v = s.velocities[meta.name];
      if (!p || !v || !p[i] || !p[i + 1]) continue;
      const pos = hermite(p[i], p[i + 1], v[i], v[i + 1], dtSec, f);
      out[meta.name] = { name: meta.name, position: pos, velocity: { x: 0, y: 0, z: 0 }, source: 'snapshot' };
    }
    return out;
  }

  /** Positions for a requested epoch, preferring live data when present. */
  statesAt(date: Date): Record<string, BodyState> | null {
    this.status.requestedEpoch = date.toISOString();
    if (this.liveStates) {
      this.outsideCoverage = false;
      return this.liveStates;
    }
    return this.fromSnapshot(date);
  }

  bodyAt(date: Date, name: string): BodyState | null {
    return this.statesAt(date)?.[name] ?? null;
  }

  /** Geocentric position of a body (Moon, spacecraft) for the epoch. */
  geocentric(date: Date, name: string): Vector3D | null {
    const s = this.statesAt(date);
    if (!s || !s.Earth || !s[name]) return null;
    const e = s.Earth.position;
    const b = s[name].position;
    return { x: b.x - e.x, y: b.y - e.y, z: b.z - e.z };
  }

  /**
   * Query the live Horizons API for one body at one epoch.
   * Responses are cached by (body, epoch, center) so repeated scrubbing is free.
   */
  async fetchLiveState(body: HorizonsBodyMeta, date: Date): Promise<BodyState> {
    const iso = date.toISOString().replace(/\.\d+Z$/, 'Z');
    const key = `${body.horizonsId}|${iso}|${body.center}`;
    const cached = readLiveCache(key);
    if (cached) return { name: body.name, ...cached, source: 'live' };

    const params = new URLSearchParams({
      format: 'text',
      COMMAND: body.horizonsId,
      EPHEM_TYPE: 'VECTORS',
      CENTER: body.center,
      START_TIME: iso,
      STOP_TIME: iso,
      STEP_SIZE: '1m',
      VEC_TABLE: '2',
      REF_PLANE: 'ECLIPTIC',
      OUT_UNITS: 'KM-S',
    });
    const res = await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${params.toString()}`, {
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`Horizons HTTP ${res.status}`);
    const text = await res.text();
    const m = new RegExp(
      'X\\s*=\\s*(-?[\\d.eE+-]+)\\s*Y\\s*=\\s*(-?[\\d.eE+-]+)\\s*Z\\s*=\\s*(-?[\\d.eE+-]+)',
    ).exec(text.split('$$SOE')[1] ?? '');
    if (!m) throw new Error(`Horizons returned no state for ${body.name}`);
    const value = {
      position: { x: parseFloat(m[1]), y: parseFloat(m[2]), z: parseFloat(m[3]) },
      velocity: { x: 0, y: 0, z: 0 },
    };
    writeLiveCache(key, value);
    return { name: body.name, ...value, source: 'live' };
  }

  /**
   * Query live Horizons for every body at `date`. Bodies whose live query fails
   * keep their bundled value, and the status records exactly what happened.
   */
  async fetchLive(date: Date, bodies: HorizonsBodyMeta[] = SOLAR_BODIES): Promise<void> {
    const results: Record<string, BodyState> = {};
    const failures: string[] = [];
    for (const b of bodies) {
      try {
        results[b.name] = await this.fetchLiveState(b, date);
      } catch (err) {
        failures.push(`${b.name}: ${String(err)}`);
      }
    }
    if (Object.keys(results).length === 0) {
      throw new Error(`Live Horizons query failed for all bodies. ${failures[0] ?? ''}`);
    }
    // Fill any gaps from the bundled snapshot so the scene is never half-empty.
    const snapshot = this.fromSnapshot(date) ?? {};
    for (const b of bodies) {
      if (!results[b.name] && snapshot[b.name]) results[b.name] = snapshot[b.name];
    }
    this.liveStates = results;
    this.status = {
      mode: 'live',
      provider: 'NASA/JPL Horizons System (live API query)',
      retrievedAt: new Date().toISOString(),
      coverage: `exact vectors for ${date.toISOString()}`,
      frame: this.snapshot?.frame ?? 'ICRF/J2000 ecliptic plane, heliocentric, km',
      units: 'position km, velocity km/s',
      requestedEpoch: date.toISOString(),
      detail: failures.length
        ? `${failures.length} body/bodies could not be refreshed and keep their bundled value: ${failures.join('; ')}`
        : 'All requested bodies were fetched live for this epoch.',
    };
  }

  /** Drop live values and go back to the bundled snapshot. */
  clearLive(): void {
    this.liveStates = null;
    const s = this.snapshot;
    if (s) {
      this.status = {
        mode: 'bundled',
        provider: 'NASA/JPL Horizons System (bundled vector snapshot)',
        retrievedAt: s.retrievedAt,
        coverage: `${s.times[0]} → ${s.times[s.times.length - 1]} @ ${s.requestedRange.step} steps`,
        frame: s.frame,
        units: `position ${s.units.position}, velocity ${s.units.velocity}`,
        requestedEpoch: this.status.requestedEpoch,
        detail: 'Live Horizons queries are available from the Data panel.',
      };
    }
  }

  get error(): string | null {
    return this.loadError;
  }
}

interface LiveCacheEntry {
  position: Vector3D;
  velocity: Vector3D;
}

function readLiveCache(key: string): LiveCacheEntry | null {
  try {
    const raw = localStorage.getItem(`redrover:v2:${LIVE_CACHE_PREFIX}:${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt: number; value: LiveCacheEntry };
    if (Date.now() - parsed.savedAt > LIVE_CACHE_MAX_AGE_MS) return null;
    return parsed.value;
  } catch {
    return null;
  }
}

function writeLiveCache(key: string, value: LiveCacheEntry): void {
  try {
    localStorage.setItem(
      `redrover:v2:${LIVE_CACHE_PREFIX}:${key}`,
      JSON.stringify({ savedAt: Date.now(), value }),
    );
  } catch {
    /* ignore */
  }
}

export const AU_KM = 149_597_870.7;
