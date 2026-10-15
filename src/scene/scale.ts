/**
 * Shared scene constants, scale model and orbit geometry for RedRover.
 *
 * Two named scale modes are used, and the UI always states which one is active.
 *
 *  OVERVIEW  — radial log-compression of heliocentric distance so all eight
 *              planets fit in one navigable view. Body meshes are enlarged.
 *              Distances are NOT to scale.
 *  FOCUS     — a true linear local scale centred on one body, used for a
 *              planetary system, its moons, and Earth-orbit traffic.
 */

import * as THREE from 'three';
import { CatalogObject } from '../data/types';
import { AU_KM, BODY_RADIUS_KM, HorizonsEphemeris } from '../data/horizons';
import { EARTH_RADIUS_KM } from '../orbit/sgp4';
import { regionOf } from '../data/types';

export const AU = AU_KM;

/** Overview: scene units per AU before radial compression. */
const OVERVIEW_AU_UNITS = 4_000;
/** Overview: inner radius of the compression, in AU. */
const OVERVIEW_R0 = 0.02;

export type ScaleMode = 'overview' | 'focus';

export interface BodyInfo {
  name: string;
  radiusKm: number;
  parent: string | null;
  kind: 'star' | 'planet' | 'moon';
}

export const BODY_INFO: Record<string, BodyInfo> = {
  Sun: { name: 'Sun', radiusKm: BODY_RADIUS_KM.Sun, parent: null, kind: 'star' },
  Mercury: { name: 'Mercury', radiusKm: BODY_RADIUS_KM.Mercury, parent: 'Sun', kind: 'planet' },
  Venus: { name: 'Venus', radiusKm: BODY_RADIUS_KM.Venus, parent: 'Sun', kind: 'planet' },
  Earth: { name: 'Earth', radiusKm: BODY_RADIUS_KM.Earth, parent: 'Sun', kind: 'planet' },
  Moon: { name: 'Moon', radiusKm: BODY_RADIUS_KM.Moon, parent: 'Earth', kind: 'moon' },
  Mars: { name: 'Mars', radiusKm: BODY_RADIUS_KM.Mars, parent: 'Sun', kind: 'planet' },
  Jupiter: { name: 'Jupiter', radiusKm: BODY_RADIUS_KM.Jupiter, parent: 'Sun', kind: 'planet' },
  Io: { name: 'Io', radiusKm: BODY_RADIUS_KM.Io, parent: 'Jupiter', kind: 'moon' },
  Europa: { name: 'Europa', radiusKm: BODY_RADIUS_KM.Europa, parent: 'Jupiter', kind: 'moon' },
  Ganymede: { name: 'Ganymede', radiusKm: BODY_RADIUS_KM.Ganymede, parent: 'Jupiter', kind: 'moon' },
  Callisto: { name: 'Callisto', radiusKm: BODY_RADIUS_KM.Callisto, parent: 'Jupiter', kind: 'moon' },
  Saturn: { name: 'Saturn', radiusKm: BODY_RADIUS_KM.Saturn, parent: 'Sun', kind: 'planet' },
  Titan: { name: 'Titan', radiusKm: BODY_RADIUS_KM.Titan, parent: 'Saturn', kind: 'moon' },
  Uranus: { name: 'Uranus', radiusKm: BODY_RADIUS_KM.Uranus, parent: 'Sun', kind: 'planet' },
  Neptune: { name: 'Neptune', radiusKm: BODY_RADIUS_KM.Neptune, parent: 'Sun', kind: 'planet' },
};

/** Render order used by the label collision pass. */
export const BODY_ORDER = Object.keys(BODY_INFO);

/** Visual (enlarged) radii used in OVERVIEW, in scene units. */
export const OVERVIEW_VISUAL_R: Record<string, number> = {
  Sun: 22,
  Mercury: 4.0,
  Venus: 5.6,
  Earth: 6.0,
  Moon: 3.2,
  Mars: 4.8,
  Jupiter: 12.0,
  Saturn: 10.0,
  Uranus: 7.2,
  Neptune: 6.6,
  Io: 1.9,
  Europa: 1.7,
  Ganymede: 2.1,
  Callisto: 2.1,
  Titan: 1.8,
};

/** Overview visual orbit radius for a moon, in scene units (keeps it selectable). */
const OVERVIEW_MOON_ORBIT: Record<string, number> = {
  Moon: 17,
  Io: 22,
  Europa: 27,
  Ganymede: 33,
  Callisto: 40,
  Titan: 26,
};

/**
 * True-scale (FOCUS) mapping: scene units per kilometre, chosen so the focused
 * body renders at `FOCUS_BODY_UNITS` scene units.
 */
export const FOCUS_BODY_UNITS = 300;

/** Scene units per kilometre when focused on `body`. */
export function unitsPerKm(body: string): number {
  return FOCUS_BODY_UNITS / Math.max(1, BODY_INFO[body].radiusKm);
}

/** Radial compression used by OVERVIEW. `r` is a heliocentric distance in km. */
export function overviewRadial(r: number): number {
  const au = r / AU;
  return OVERVIEW_R0 * Math.log10(1 + au / OVERVIEW_R0) * OVERVIEW_AU_UNITS;
}

/** Linear scale factor at a heliocentric distance, used for size references. */
export function overviewUnitsPerKm(r: number): number {
  const au = Math.max(1e-9, r / AU);
  return (OVERVIEW_AU_UNITS * OVERVIEW_R0) / (au + OVERVIEW_R0) / (Math.LN10 * AU);
}

/**
 * Map a heliocentric km position into OVERVIEW scene coordinates. The radial
 * distance is compressed but the direction is preserved exactly.
 */
export function overviewPosition(p: THREE.Vector3): THREE.Vector3 {
  const r = Math.max(1e-6, p.length());
  return p.clone().multiplyScalar(overviewRadial(r) / r);
}

/**
 * Map a local (body-relative) km vector into OVERVIEW scene coordinates. Used
 * for moons and satellites: the offset is scaled by the parent's local linear
 * factor and then given a floor so it stays outside the enlarged parent mesh.
 */
export function overviewOffset(v: THREE.Vector3, floorUnits: number): THREE.Vector3 {
  const len = v.length();
  if (len < 1e-6) return new THREE.Vector3(0, floorUnits, 0);
  const scaled = v.clone().multiplyScalar(overviewUnitsPerKm(len));
  if (scaled.length() < floorUnits) scaled.setLength(floorUnits);
  return scaled;
}

/**
 * Map a heliocentric km position into FOCUS scene coordinates relative to
 * `originKm` (the focused body's heliocentric position).
 */
export function focusPosition(p: THREE.Vector3, originKm: THREE.Vector3, kmPerUnit: number): THREE.Vector3 {
  return p.clone().sub(originKm).multiplyScalar(kmPerUnit);
}

/** Visual radius in scene units for a body in OVERVIEW. */
export function overviewVisualRadius(name: string): number {
  return OVERVIEW_VISUAL_R[name] ?? 2;
}

/**
 * How much a body is enlarged in OVERVIEW relative to a true linear scale at
 * its own distance. Reported in the UI so the compression is never hidden.
 */
export function exaggerationFactor(name: string, helioR: number): number {
  const visual = overviewVisualRadius(name);
  const trueUnits = BODY_INFO[name].radiusKm * overviewUnitsPerKm(helioR);
  if (trueUnits <= 0) return Infinity;
  return visual / trueUnits;
}

/** Visual orbit radius for a moon in OVERVIEW. */
export function overviewMoonOrbit(name: string): number {
  return OVERVIEW_MOON_ORBIT[name] ?? 8;
}

// ─────────────────────────────────────────────────────────────────────────────
// JPL approximate Keplerian elements (J2000 mean ecliptic)
// Source: E.M. Standish, "Keplerian Elements for Approximate Positions of the
// Major Planets", JPL Solar System Dynamics. Used ONLY to draw orbit lines;
// body positions come from JPL Horizons vector ephemerides.
// ─────────────────────────────────────────────────────────────────────────────

interface KepEl {
  a: number; e: number; i: number; L: number; peri: number; node: number;
  da: number; de: number; di: number; dL: number; dperi: number; dnode: number;
}

export const KEPLER: Record<string, KepEl> = {
  Mercury: { a: 0.38709927, e: 0.20563593, i: 7.00497902, L: 252.25032350, peri: 77.45779628, node: 48.33076593, da: 0.00000037, de: 0.00001906, di: -0.00594749, dL: 149472.67411175, dperi: 0.16047689, dnode: -0.12534081 },
  Venus: { a: 0.72333566, e: 0.00677672, i: 3.39467605, L: 181.97909950, peri: 131.60246718, node: 76.67984255, da: 0.00000390, de: -0.00004107, di: -0.00078890, dL: 58517.81538729, dperi: 0.00268329, dnode: -0.27769418 },
  Earth: { a: 1.00000261, e: 0.01671123, i: -0.00001531, L: 100.46457166, peri: 102.93768193, node: 0.0, da: 0.00000562, de: -0.00004392, di: -0.01294668, dL: 35999.37244981, dperi: 0.32327364, dnode: 0.0 },
  Mars: { a: 1.52371034, e: 0.09339410, i: 1.84969142, L: -4.55343205, peri: -23.94362959, node: 49.55953891, da: 0.00001847, de: 0.00007882, di: -0.00813131, dL: 19140.30268499, dperi: 0.44441088, dnode: -0.29257343 },
  Jupiter: { a: 5.20288700, e: 0.04838624, i: 1.30439695, L: 34.39644051, peri: 14.72847983, node: 100.47390909, da: -0.00011607, de: -0.00013253, di: -0.00183714, dL: 3034.74612775, dperi: 0.21252668, dnode: 0.20469106 },
  Saturn: { a: 9.53667594, e: 0.05386179, i: 2.48599187, L: 49.95424423, peri: 92.59887831, node: 113.66242448, da: -0.00125060, de: -0.00050991, di: 0.00193609, dL: 1222.49362201, dperi: -0.41897216, dnode: -0.28867794 },
  Uranus: { a: 19.18916464, e: 0.04725744, i: 0.77263783, L: 313.23810451, peri: 170.95427630, node: 74.01692503, da: -0.00196176, de: -0.00004397, di: -0.00242939, dL: 428.48202785, dperi: 0.40805281, dnode: 0.04240589 },
  Neptune: { a: 30.06992276, e: 0.00859048, i: 1.77004347, L: -55.12002969, peri: 44.96476227, node: 131.78422574, da: 0.00026291, de: 0.00005105, di: 0.00035372, dL: 218.45945325, dperi: -0.32241464, dnode: -0.00508664 },
};

/** Sample a planet's orbit as heliocentric AU points for the requested date. */
export function orbitPointsAu(body: string, date: Date, samples = 256): THREE.Vector3[] {
  const el = KEPLER[body];
  if (!el) return [];
  const T = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / (36525 * 86_400_000);
  const a = el.a + el.da * T;
  const e = el.e + el.de * T;
  const i = ((el.i + el.di * T) * Math.PI) / 180;
  const peri = ((el.peri + el.dperi * T) * Math.PI) / 180;
  const node = ((el.node + el.dnode * T) * Math.PI) / 180;
  const pts: THREE.Vector3[] = [];
  for (let k = 0; k <= samples; k++) {
    const M = (k / samples) * Math.PI * 2;
    // Solve Kepler's equation.
    let E = M;
    for (let n = 0; n < 6; n++) E = M + e * Math.sin(E);
    const xo = a * (Math.cos(E) - e);
    const yo = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const cw = Math.cos(peri);
    const sw = Math.sin(peri);
    const cn = Math.cos(node);
    const sn = Math.sin(node);
    const ci = Math.cos(i);
    const si = Math.sin(i);
    const x = (cw * cn - sw * sn * ci) * xo + (-sw * cn - cw * sn * ci) * yo;
    const y = (cw * sn + sw * cn * ci) * xo + (-sw * sn + cw * cn * ci) * yo;
    const z = sw * si * xo + cw * si * yo;
    pts.push(new THREE.Vector3(x, y, z));
  }
  return pts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Satellite rendering
// ─────────────────────────────────────────────────────────────────────────────

export interface SatelliteFilter {
  payload: boolean;
  rocketBody: boolean;
  debris: boolean;
  regions: Set<string>;
  nameQuery: string;
}

export const EMPTY_FILTER: SatelliteFilter = {
  payload: true,
  rocketBody: true,
  debris: true,
  regions: new Set(['LEO', 'MEO', 'GEO', 'HEO', 'other']),
  nameQuery: '',
};

export function matchesFilter(o: CatalogObject, f: SatelliteFilter): boolean {
  if (o.type === 'payload' && !f.payload) return false;
  if (o.type === 'rocket_body' && !f.rocketBody) return false;
  if (o.type === 'debris' && !f.debris) return false;
  if (!f.regions.has(regionOf(o.altitudeKm, o.inclinationDeg))) return false;
  if (f.nameQuery && !o.name.toLowerCase().includes(f.nameQuery.toLowerCase())) return false;
  return true;
}

/** Number of cells in an (altitude, azimuth, polar) occupancy grid. */
export function cellsOf(altBands: number, azSectors: number, polarSectors: number): number {
  return altBands * azSectors * polarSectors;
}

/** Earth-centred TEME → Earth-centred inertial (ECI) position, km. */
export function temeToEci(p: THREE.Vector3, gmstRad: number): THREE.Vector3 {
  const c = Math.cos(gmstRad);
  const s = Math.sin(gmstRad);
  return new THREE.Vector3(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
}
