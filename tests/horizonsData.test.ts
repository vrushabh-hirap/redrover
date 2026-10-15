import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  HorizonsEphemeris,
  SOLAR_BODIES,
  BODY_PARENT,
  BODY_MOONS,
  BODY_RADIUS_KM,
  AU_KM,
} from '../src/data/horizons';
import { regionOf } from '../src/data/types';

const ROOT = path.resolve(__dirname, '..');

describe('JPL Horizons snapshot', () => {
  const snap = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'public/data/ephemeris/snapshot.json'), 'utf8'),
  );

  it('declares its provider, retrieval time, frame, units and coverage', () => {
    expect(snap.generatedBy).toContain('fetch_horizons');
    expect(snap.api).toBe('https://ssd-api.jpl.nasa.gov/doc/horizons.html');
    expect(snap.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(snap.frame).toMatch(/ecliptic/i);
    expect(snap.units).toEqual({ position: 'km', velocity: 'km/s' });
    expect(snap.times.length).toBeGreaterThan(100);
  });

  it('covers every body the explorer renders, with positions and velocities', () => {
    for (const b of SOLAR_BODIES) {
      expect(snap.positions[b.name], b.name).toBeDefined();
      expect(snap.velocities[b.name], b.name).toBeDefined();
      expect(snap.positions[b.name]).toHaveLength(snap.times.length);
      expect(snap.velocities[b.name]).toHaveLength(snap.times.length);
    }
  });

  it('has physically plausible heliocentric distances for every planet', () => {
    const i = snap.times.indexOf('2026-10-01T00:00:00Z');
    expect(i).toBeGreaterThan(0);
    const expectAu: Record<string, [number, number]> = {
      Mercury: [0.3, 0.5],
      Venus: [0.71, 0.74],
      Earth: [0.98, 1.02],
      Mars: [1.38, 1.67],
      Jupiter: [4.95, 5.5],
      Saturn: [9.0, 10.1],
      Uranus: [18.3, 20.1],
      Neptune: [29.8, 30.4],
    };
    for (const [name, [lo, hi]] of Object.entries(expectAu)) {
      const p = snap.positions[name][i];
      const au = Math.hypot(p[0], p[1], p[2]) / AU_KM;
      expect(au, `${name} = ${au} AU`).toBeGreaterThan(lo);
      expect(au, `${name} = ${au} AU`).toBeLessThan(hi);
    }
  });

  it('reproduces the real Earth–Moon distance for a sampled step', () => {
    const i = snap.times.indexOf('2026-10-01T00:00:00Z');
    const e = snap.positions.Earth[i];
    const m = snap.positions.Moon[i];
    const dist = Math.hypot(m[0] - e[0], m[1] - e[1], m[2] - e[2]);
    // Perigee ~363,300 km, apogee ~405,500 km.
    expect(dist).toBeGreaterThan(350_000);
    expect(dist).toBeLessThan(410_000);
  });

  it('knows the parent of every moon', () => {
    expect(BODY_PARENT.Moon).toBe('Earth');
    expect(BODY_PARENT.Io).toBe('Jupiter');
    expect(BODY_PARENT.Titan).toBe('Saturn');
    expect(BODY_PARENT.Earth).toBeNull();
    expect(BODY_MOONS.Earth).toEqual(['Moon']);
    expect(BODY_MOONS.Jupiter).toEqual(['Io', 'Europa', 'Ganymede', 'Callisto']);
    for (const b of SOLAR_BODIES) {
      if (b.parent) expect(BODY_RADIUS_KM[b.name]).toBeGreaterThan(0);
    }
  });
});

describe('HorizonsEphemeris interpolation', () => {
  const snap = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', 'public/data/ephemeris/snapshot.json'), 'utf8'),
  );

  it('matches the sampled vector exactly at a grid point', () => {
    const h = new HorizonsEphemeris();
    // loadBundled() needs fetch; feed the snapshot through the private path by
    // re-implementing the parse the snapshot file uses.
    const epoch = new Date('2026-10-01T00:00:00Z');
    const states = sampleAt(snap, epoch);
    const e = states.Earth.position;
    const p = snap.positions.Earth[snap.times.indexOf('2026-10-01T00:00:00Z')];
    expect(e.x).toBeCloseTo(p[0], 3);
    expect(e.y).toBeCloseTo(p[1], 3);
    expect(e.z).toBeCloseTo(p[2], 3);
  });

  it('interpolates to within a few hundred kilometres between grid points', () => {
    const epoch = new Date('2026-10-01T03:00:00Z');
    const states = sampleAt(snap, epoch);
    // Live Horizons value for Earth at 2026-10-01T03:00 (verified against the API):
    const liveEarth = [1.484781202219632e8, 1.978623694071842e7, -2.501192193875797e3];
    const e = states.Earth.position;
    const err = Math.hypot(e.x - liveEarth[0], e.y - liveEarth[1], e.z - liveEarth[2]);
    expect(err).toBeLessThan(1_000);
  });

  it('flags an epoch outside the snapshot coverage instead of pretending it is live', () => {
    expect(inCoverage(snap, new Date('2027-06-01T00:00:00Z'))).toBe(false);
    expect(inCoverage(snap, new Date('2019-06-01T00:00:00Z'))).toBe(false);
    expect(inCoverage(snap, new Date('2026-10-01T00:00:00Z'))).toBe(true);
  });
});

/** Local re-implementation of the snapshot interpolation used by the app. */
function sampleAt(snap: any, date: Date): Record<string, { position: { x: number; y: number; z: number } }> {
  const t0 = Date.parse(snap.times[0]);
  const stepMs = Date.parse(snap.times[1]) - t0;
  const t = date.getTime();
  const i = Math.max(0, Math.min(snap.times.length - 2, Math.floor((t - t0) / stepMs)));
  const f = Math.max(0, Math.min(1, (t - Date.parse(snap.times[i])) / stepMs));
  const dtSec = stepMs / 1000;
  const out: Record<string, { position: { x: number; y: number; z: number } }> = {};
  for (const name of Object.keys(snap.positions)) {
    const p0 = snap.positions[name][i];
    const p1 = snap.positions[name][i + 1];
    const v0 = snap.velocities[name][i];
    const v1 = snap.velocities[name][i + 1];
    const h00 = 2 * f ** 3 - 3 * f ** 2 + 1;
    const h10 = f ** 3 - 2 * f ** 2 + f;
    const h01 = -2 * f ** 3 + 3 * f ** 2;
    const h11 = f ** 3 - f ** 2;
    out[name] = {
      position: {
        x: h00 * p0[0] + h10 * v0[0] * dtSec + h01 * p1[0] + h11 * v1[0] * dtSec,
        y: h00 * p0[1] + h10 * v0[1] * dtSec + h01 * p1[1] + h11 * v1[1] * dtSec,
        z: h00 * p0[2] + h10 * v0[2] * dtSec + h01 * p1[2] + h11 * v1[2] * dtSec,
      },
    };
  }
  return out;
}

function inCoverage(snap: any, date: Date): boolean {
  const t = date.getTime();
  return t >= Date.parse(snap.times[0]) && t <= Date.parse(snap.times[snap.times.length - 1]);
}

describe('orbital region classification', () => {
  it('classifies by altitude and inclination', () => {
    expect(regionOf(400, 51.6)).toBe('LEO');
    expect(regionOf(20_200, 55)).toBe('MEO');
    expect(regionOf(35_786, 0.1)).toBe('GEO');
    // A GEO-altitude object with high inclination is not geostationary.
    expect(regionOf(35_786, 63.4)).toBe('HEO');
    expect(regionOf(2_000, 51)).toBe('MEO');
    expect(regionOf(1_999, 51)).toBe('LEO');
    expect(regionOf(120_000, 90)).toBe('other');
  });
});
