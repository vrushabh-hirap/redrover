import * as satellite from 'satellite.js';
import { CatalogObject, PropagatedState } from '../data/types';

export const EARTH_RADIUS_KM = 6378.137;
export const MU_EARTH = 398_600_441_800; // m^3/s^2
export const MU_EARTH_KM = 398_600.4418; // km^3/s^2
export const EARTH_ROTATION_RATE_RAD_S = 7.2921159e-5;

/**
 * SGP4 propagation of a catalogued element set.
 *
 * Element sets are built once (satellite.js does the parsing/validation); the
 * propagator then produces states for arbitrary times. This object holds no
 * per-frame state, so it can be reused from a worker or the render loop.
 */
export class Sgp4Propagator {
  private satrecs = new Map<number, satellite.SatRec>();
  private bad = new Set<number>();

  constructor(objects: CatalogObject[] = []) {
    this.load(objects);
  }

  load(objects: CatalogObject[]): void {
    this.satrecs.clear();
    this.bad.clear();
    for (const obj of objects) {
      try {
        const satrec = satellite.twoline2satrec(obj.line1, obj.line2);
        if (!satrec || satrec.error) {
          this.bad.add(obj.noradId);
          continue;
        }
        this.satrecs.set(obj.noradId, satrec);
      } catch {
        this.bad.add(obj.noradId);
      }
    }
  }

  get validCount(): number {
    return this.satrecs.size;
  }

  get invalidCount(): number {
    return this.bad.size;
  }

  has(noradId: number): boolean {
    return this.satrecs.has(noradId);
  }

  propagateSingle(noradId: number, date: Date): PropagatedState | null {
    const satrec = this.satrecs.get(noradId);
    if (!satrec) return null;
    return stateFrom(satrec, noradId, date);
  }

  /** Propagate every object; returns only the states that succeeded. */
  propagateBatch(date: Date, ids?: number[]): PropagatedState[] {
    const out: PropagatedState[] = [];
    const list = ids ?? [...this.satrecs.keys()];
    for (const id of list) {
      const satrec = this.satrecs.get(id);
      if (!satrec) continue;
      const st = stateFrom(satrec, id, date);
      if (st && !st.error) out.push(st);
    }
    return out;
  }
}

function stateFrom(satrec: satellite.SatRec, noradId: number, date: Date): PropagatedState {
  const pv = satellite.propagate(satrec, date);
  if (!pv || !pv.position || typeof pv.position === 'boolean' || !pv.velocity || typeof pv.velocity === 'boolean') {
    return {
      noradId,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      altitudeKm: 0,
      speedKmS: 0,
      error: true,
    };
  }
  const p = pv.position;
  const v = pv.velocity;
  return {
    noradId,
    position: { x: p.x, y: p.y, z: p.z },
    velocity: { x: v.x, y: v.y, z: v.z },
    altitudeKm: Math.hypot(p.x, p.y, p.z) - EARTH_RADIUS_KM,
    speedKmS: Math.hypot(v.x, v.y, v.z),
  };
}

/** GMST (Greenwich Mean Sidereal Time) in radians — used for Earth-fixed frames. */
export function gmst(date: Date): number {
  return satellite.gstime(date);
}

/** Two-body circular orbit speed, km/s. */
export function circularOrbitSpeedKmS(altitudeKm: number): number {
  return Math.sqrt(MU_EARTH_KM / (EARTH_RADIUS_KM + altitudeKm));
}

/** Standard coplanar circular→circular Hohmann transfer, km/s and seconds. */
export function hohmannDeltaV(r1Km: number, r2Km: number) {
  const a = (r1Km + r2Km) / 2;
  const v1 = Math.sqrt(MU_EARTH_KM / r1Km);
  const v2 = Math.sqrt(MU_EARTH_KM / r2Km);
  const vt1 = Math.sqrt(MU_EARTH_KM * (2 / r1Km - 1 / a));
  const vt2 = Math.sqrt(MU_EARTH_KM * (2 / r2Km - 1 / a));
  return {
    dv1: Math.abs(vt1 - v1),
    dv2: Math.abs(v2 - vt2),
    totalDv: Math.abs(vt1 - v1) + Math.abs(v2 - vt2),
    transferTimeSec: Math.PI * Math.sqrt(a ** 3 / MU_EARTH_KM),
  };
}

/** Keplerian period (minutes) of a circular orbit at `altitudeKm`. */
export function periodMinAt(altitudeKm: number): number {
  const r = EARTH_RADIUS_KM + altitudeKm;
  return (2 * Math.PI * Math.sqrt(r ** 3 / MU_EARTH_KM)) / 60;
}
