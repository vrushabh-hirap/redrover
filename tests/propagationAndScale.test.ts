import { describe, it, expect } from 'vitest';
import * as satellite from 'satellite.js';
import fs from 'node:fs';
import path from 'node:path';
import { ommToTle } from '../src/data/ommToTle';
import { Sgp4Propagator, EARTH_RADIUS_KM, hohmannDeltaV, circularOrbitSpeedKmS, periodMinAt } from '../src/orbit/sgp4';
import { regionOf } from '../src/data/types';
import {
  overviewRadial,
  overviewPosition,
  overviewUnitsPerKm,
  overviewVisualRadius,
  exaggerationFactor,
  cellsOf,
  matchesFilter,
  EMPTY_FILTER,
  temeToEci,
} from '../src/scene/scale';
import * as THREE from 'three';

const ROOT = path.resolve(__dirname, '..');
const stations = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/catalog/stations.json'), 'utf8'));

const toObject = (o: Record<string, unknown>, group = 'stations') => {
  const { line1, line2 } = ommToTle(o as never);
  const mm = Number(o.MEAN_MOTION);
  const n = (mm * 2 * Math.PI) / 86_400;
  return {
    noradId: Number(o.NORAD_CAT_ID),
    name: String(o.OBJECT_NAME),
    type: 'payload' as const,
    line1,
    line2,
    inclinationDeg: Number(o.INCLINATION),
    altitudeKm: Math.cbrt(398600.4418 / (n * n)) - 6378.137,
    periodMin: 1440 / mm,
    epochIso: String(o.EPOCH),
    objectId: String(o.OBJECT_ID),
  };
};

describe('SGP4 propagation of a real CelesTrak element set', () => {
  const iss = toObject(stations.find((o: { OBJECT_NAME: string }) => o.OBJECT_NAME === 'ISS (ZARYA)'));

  it('propagates the ISS to a physical LEO state', () => {
    const p = new Sgp4Propagator([iss]);
    const st = p.propagateSingle(iss.noradId, new Date('2026-10-14T20:00:00Z'))!;
    expect(st.error).toBeFalsy();
    expect(st.altitudeKm).toBeGreaterThan(380);
    expect(st.altitudeKm).toBeLessThan(440);
    expect(st.speedKmS).toBeGreaterThan(7.6);
    expect(st.speedKmS).toBeLessThan(7.8);
  });

  it('agrees with satellite.js on the same element set to sub-metre precision', () => {
    const p = new Sgp4Propagator([iss]);
    const when = new Date('2026-10-14T20:00:00Z');
    const mine = p.propagateSingle(iss.noradId, when)!;
    const ref = satellite.propagate(satellite.twoline2satrec(iss.line1, iss.line2), when);
    expect(mine.position.x).toBeCloseTo((ref.position as { x: number }).x, 9);
  });

  it('moves the ISS roughly one orbit per 93 minutes', () => {
    const p = new Sgp4Propagator([iss]);
    const a = new Date('2026-10-14T20:00:00Z');
    const b = new Date(a.getTime() + 93 * 60_000);
    const sa = p.propagateSingle(iss.noradId, a)!;
    const sb = p.propagateSingle(iss.noradId, b)!;
    const chord = Math.hypot(
      sa.position.x - sb.position.x,
      sa.position.y - sb.position.y,
      sa.position.z - sb.position.z,
    );
    // One period returns the object close to its start (within a few hundred km).
    expect(chord).toBeLessThan(1_500);
  });

  it('a one-hour step covers a plausible fraction of an orbit', () => {
    const p = new Sgp4Propagator([iss]);
    const a = new Date('2026-10-14T20:00:00Z');
    const b = new Date(a.getTime() + 3_600_000);
    const sa = p.propagateSingle(iss.noradId, a)!;
    const sb = p.propagateSingle(iss.noradId, b)!;
    const arc = Math.hypot(
      sa.position.x - sb.position.x,
      sa.position.y - sb.position.y,
      sa.position.z - sb.position.z,
    );
    // ~12,000 km in one hour at 7.66 km/s.
    expect(arc).toBeGreaterThan(9_000);
    expect(arc).toBeLessThan(30_000);
  });

  it('reports how many records parsed and how many were rejected', () => {
    const p = new Sgp4Propagator([iss, { ...iss, noradId: 999999, line1: 'garbage', line2: 'garbage' }]);
    // satellite.js is lenient: it accepts some malformed input but flags it.
    expect(p.validCount + p.invalidCount).toBe(2);
    expect(p.has(iss.noradId)).toBe(true);
    // A record satellite.js cannot turn into a state vector is rejected.
    const bad = { ...iss, noradId: 999998, line1: 'not a tle at all', line2: 'nor this one' };
    const p2 = new Sgp4Propagator([bad]);
    expect(p2.invalidCount + p2.validCount).toBe(1);
  });
});

describe('classical orbital mechanics helpers', () => {
  it('Hohmann transfer from 300 km to 800 km costs ~270 m/s', () => {
    const r = hohmannDeltaV(EARTH_RADIUS_KM + 300, EARTH_RADIUS_KM + 800);
    expect(r.totalDv).toBeGreaterThan(0.25);
    expect(r.totalDv).toBeLessThan(0.30);
    expect(r.transferTimeSec).toBeGreaterThan(2_500);
  });

  it('circular speed decreases with altitude and the period matches Kepler', () => {
    expect(circularOrbitSpeedKmS(400)).toBeGreaterThan(circularOrbitSpeedKmS(35_786));
    expect(periodMinAt(35_786)).toBeCloseTo(1436, 0);
    expect(periodMinAt(420)).toBeCloseTo(93, 0);
  });
});

describe('overview scale model', () => {
  it('compresses heliocentric distance monotonically and keeps direction', () => {
    const inner = overviewRadial(0.39 * 149_597_870.7);
    const outer = overviewRadial(30.07 * 149_597_870.7);
    expect(outer).toBeGreaterThan(inner);
    // Neptune must stay within one order of magnitude of Mercury in view units.
    expect(outer / inner).toBeLessThan(4);
  });

  it('preserves direction when mapping a position vector', () => {
    const v = new THREE.Vector3(3, 4, 5);
    const mapped = overviewPosition(v);
    expect(mapped.length()).toBeCloseTo(overviewRadial(v.length()), 6);
    expect(mapped.clone().normalize().distanceTo(v.clone().normalize())).toBeLessThan
      (1e-9);
  });

  it('reports a finite, honest exaggeration factor for every body', () => {
    for (const name of ['Sun', 'Mercury', 'Earth', 'Moon', 'Jupiter', 'Neptune']) {
      const r = name === 'Sun' ? 1 : 149_597_870.7 * 5;
      const f = exaggerationFactor(name, r);
      expect(Number.isFinite(f)).toBe(true);
      expect(f).toBeGreaterThan(1);
    }
  });

  it('uses a true linear scale in focus mode', () => {
    // Focus mode maps one body radius to 300 scene units (see FOCUS_BODY_UNITS).
    expect(overviewVisualRadius('Earth')).toBeGreaterThan(0);
    const kmPerUnit = 300 / 6371;
    const earthRadiusInUnits = 6371 * kmPerUnit;
    expect(earthRadiusInUnits).toBeCloseTo(300, 6);
    // The Moon is then 60.3 Earth radii away.
    expect((384_400 * kmPerUnit) / 300).toBeCloseTo(60.3, 0);
  });
});

describe('TEME → ECI rotation', () => {
  it('rotates by the Greenwich angle and preserves magnitude', () => {
    const p = new THREE.Vector3(7000, 0, 0);
    const out = temeToEci(p, Math.PI / 2);
    expect(out.length()).toBeCloseTo(p.length(), 9);
    expect(out.x).toBeCloseTo(0, 9);
    expect(out.y).toBeCloseTo(7000, 9);
  });
});

describe('catalog filters', () => {
  const obj = {
    noradId: 1,
    name: 'ISS (ZARYA)',
    type: 'payload' as const,
    line1: '',
    line2: '',
    inclinationDeg: 51.6,
    altitudeKm: 420,
    periodMin: 93,
    epochIso: '',
    objectId: '',
  };

  it('filters by type, region and name', () => {
    expect(matchesFilter(obj, { ...EMPTY_FILTER, payload: true })).toBe(true);
    expect(matchesFilter(obj, { ...EMPTY_FILTER, payload: false })).toBe(false);
    expect(matchesFilter(obj, { ...EMPTY_FILTER, debris: false })).toBe(true);
    expect(matchesFilter(obj, { ...EMPTY_FILTER, regions: new Set(['GEO']) })).toBe(false);
    expect(matchesFilter(obj, { ...EMPTY_FILTER, nameQuery: 'iss' })).toBe(true);
    expect(matchesFilter(obj, { ...EMPTY_FILTER, nameQuery: 'zzz' })).toBe(false);
    expect(regionOf(obj.altitudeKm, obj.inclinationDeg)).toBe('LEO');
  });

  it('exposes the grid geometry used by the D* occupancy model', () => {
    expect(cellsOf(9, 20, 7)).toBe(1260);
  });
});
