/**
 * Real-data access layer for RedRover.
 *
 * Two provenance chains are used, and both are described in the UI and in
 * DATA_SOURCES.md:
 *
 *  1. Solar-system body positions — NASA/JPL Horizons System vector ephemerides.
 *     `horizons.ts` can query the live API for any requested UTC epoch and also
 *     reads a dated, bundled snapshot produced by
 *     `preprocessing/fetch_horizons.js`.
 *
 *  2. Earth-orbit objects — CelesTrak General Perturbations catalog
 *     (underlying provider: US Space Force / Space-Track). `celestrak.ts` can
 *     query live and also reads a dated, bundled snapshot.
 *
 * Nothing in here fabricates positions. When neither live nor bundled data is
 * available the caller is told so explicitly; the UI labels it as unavailable.
 */

import { Vector3D } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

export type DataStatus =
  | 'live'          // fetched from the upstream provider in this session
  | 'bundled'       // read from a dated snapshot shipped with the app
  | 'cached'        // read from browser storage, still dated
  | 'synthetic'     // explicitly labelled fallback, never presented as real
  | 'unavailable';  // no data; caller must show an error state

export interface SourceInfo {
  status: DataStatus;
  provider: string;
  /** ISO timestamp of when this app retrieved the upstream record. */
  retrievedAt: string;
  /** Human readable description of the epoch(s) contained in the data. */
  epoch: string;
  detail?: string;
}

export const ISO = (d: Date): string => d.toISOString();

/** Read/write a versioned localStorage cache. Never throws. */
export function cacheRead<T>(key: string, maxAgeMs: number): { value: T; ageMs: number } | null {
  try {
    const raw = localStorage.getItem(`redrover:v2:${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt: number; value: T };
    const ageMs = Date.now() - parsed.savedAt;
    if (ageMs > maxAgeMs) return null;
    return { value: parsed.value, ageMs };
  } catch {
    return null;
  }
}

export function cacheWrite(key: string, value: unknown): void {
  try {
    localStorage.setItem(`redrover:v2:${key}`, JSON.stringify({ savedAt: Date.now(), value }));
  } catch {
    /* storage unavailable or full — cache is an optimisation only */
  }
}

export const VEC = (x: number, y: number, z: number): Vector3D => ({ x, y, z });

export function dist(a: Vector3D, b: Vector3D): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
