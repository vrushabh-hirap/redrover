/**
 * Shared types for RedRover.
 */

export interface Vector3D {
  x: number;
  y: number;
  z: number;
}

export type OrbitalObjectType = 'payload' | 'rocket_body' | 'debris';

export interface CatalogObject {
  noradId: number;
  name: string;
  type: OrbitalObjectType;
  line1: string;
  line2: string;
  inclinationDeg: number;
  altitudeKm: number;
  periodMin: number;
  /** ISO timestamp of the element epoch (UTC). */
  epochIso: string;
  /** International designator, e.g. "1998-067A". */
  objectId: string;
}

export interface PropagatedState {
  noradId: number;
  /** TEME frame, Earth-centred, km (SGP4 output frame). */
  position: Vector3D;
  /** TEME frame, km/s. */
  velocity: Vector3D;
  altitudeKm: number;
  speedKmS: number;
  error?: boolean;
}

export type OrbitalRegion = 'LEO' | 'MEO' | 'GEO' | 'HEO' | 'other';

export function regionOf(altitudeKm: number, inclinationDeg: number): OrbitalRegion {
  // LEO / MEO bands, then the GEO belt and its high-inclination (GTO / HEO)
  // neighbours. A GEO-altitude object with a high inclination is not a
  // geostationary spacecraft, so it is reported as HEO.
  if (altitudeKm < 2_000) return 'LEO';
  if (altitudeKm < 35_786) return 'MEO';
  if (altitudeKm < 40_000) {
    return inclinationDeg < 20 ? 'GEO' : 'HEO';
  }
  return 'other';
}
