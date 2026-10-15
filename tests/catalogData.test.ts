import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ommToTle, epochToDayOfYear, tleChecksum, exponential, firstDerivative } from '../src/data/ommToTle';
import { classifyObject, CATALOG_GROUPS, DEFAULT_GROUP } from '../src/data/celestrak';

const ROOT = path.resolve(__dirname, '..');
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const stations = readJson('public/data/catalog/stations.json');

describe('CelesTrak OMM → TLE conversion', () => {
  it('produces well-formed 69-character, check-summed element sets', () => {
    for (const o of stations) {
      const { line1, line2 } = ommToTle(o);
      expect(line1).toHaveLength(69);
      expect(line2).toHaveLength(69);
      expect(line1[0]).toBe('1');
      expect(line2[0]).toBe('2');
      expect(Number(line1[68])).toBe(tleChecksum(line1.slice(0, 68)));
      expect(Number(line2[68])).toBe(tleChecksum(line2.slice(0, 68)));
    }
  });

  it('reproduces the ISS element set that CelesTrak publishes as TLE text', () => {
    const iss = stations.find((o: { OBJECT_NAME: string }) => o.OBJECT_NAME === 'ISS (ZARYA)');
    const { line1, line2 } = ommToTle(iss);
    // Reference TLE captured from CelesTrak (GROUP=stations, FORMAT=tle) on the
    // same retrieval date; small last-digit differences are expected.
    expect(line1).toMatch(/^1 25544U 98067A   26/);
    expect(line2).toMatch(/^2 25544  51\.6325  73\.0089 0006710 259\.3258 100\.6975 15\.48855783/);
    // Inclination, RAAN, eccentricity, argument and mean motion round-trip.
    expect(line2.slice(8, 16).trim()).toBe('51.6325');
    expect(line2.slice(17, 25).trim()).toBe('73.0089');
    expect(line2.slice(26, 33).trim()).toBe('0006710');
    expect(line2.slice(52, 63).trim()).toBe('15.48855783');
  });

  it('formats exponential fields the way the TLE format requires', () => {
    expect(exponential(0.00012830727)).toBe(' 12831-3');
    expect(exponential(0)).toBe(' 00000+0');
    expect(exponential(0.00012830727).length).toBe(8);
  });

  it('formats the first-derivative field with an implied decimal point', () => {
    expect(firstDerivative(6.592e-5)).toBe(' .00006592');
    expect(firstDerivative(0)).toBe(' .00000000');
  });

  it('converts OMM epochs as UTC even when the zone designator is absent', () => {
    const withZ = epochToDayOfYear('2026-10-13T19:43:22.113408Z');
    const withoutZ = epochToDayOfYear('2026-10-13T19:43:22.113408');
    expect(withZ).toEqual(withoutZ);
    expect(withZ.doy).toBeCloseTo(286.82178, 4);
    // Day-of-year for 1 January 12:00 must be 1.5.
    expect(epochToDayOfYear('2026-01-01T12:00:00Z').doy).toBeCloseTo(1.5, 10);
  });

  it('rejects records that cannot be propagated', () => {
    expect(() => ommToTle({})).toThrow(/NORAD_CAT_ID/);
    expect(() => ommToTle({ NORAD_CAT_ID: '1', EPOCH: 'not-a-date' })).toThrow(/EPOCH/);
  });
});

describe('catalog object classification', () => {
  it('treats fragments in break-up groups as debris and the parent as a payload', () => {
    expect(classifyObject('COSMOS 2251 DEB (PART 3)', 'cosmos-2251-debris')).toBe('debris');
    expect(classifyObject('COSMOS 2251', 'cosmos-2251-debris')).toBe('payload');
    expect(classifyObject('IRIDIUM 33 DEB', 'iridium-33-debris')).toBe('debris');
    expect(classifyObject('IRIDIUM 33', 'iridium-33-debris')).toBe('payload');
  });

  it('identifies rocket bodies and debris from names outside break-up groups', () => {
    expect(classifyObject('SL-16 R/B', 'last-30-days')).toBe('rocket_body');
    expect(classifyObject('FENGYUN 1C DEB', 'stations')).toBe('debris');
    expect(classifyObject('ISS (ZARYA)', 'stations')).toBe('payload');
  });
});

describe('bundled catalog snapshots', () => {
  const groups = readJson('public/data/catalog/manifest.json').groups;

  it('ship a manifest that documents provider, retrieval time and epochs', () => {
    const manifest = readJson('public/data/catalog/manifest.json');
    expect(manifest.provider).toMatch(/CelesTrak/);
    expect(manifest.provider).toMatch(/Space-Track/);
    expect(manifest.formatDocumentation).toContain('celestrak.org');
    expect(manifest.usefulRange).toMatch(/7 days/);
    for (const g of groups) expect(g.objectCount).toBeGreaterThan(0);
  });

  it('every bundled group parses into propagatable element sets', async () => {
    const { ommToTle: toTle } = await import('../src/data/ommToTle');
    const satellite = await import('satellite.js');
    for (const g of groups) {
      const raw = readJson(`public/data/catalog/${g.file}`);
      expect(Array.isArray(raw)).toBe(true);
      let ok = 0;
      for (const o of raw) {
        try {
          const { line1, line2 } = toTle(o);
          const satrec = satellite.twoline2satrec(line1, line2);
          if (satrec && !satrec.error) ok++;
        } catch {
          /* malformed record */
        }
      }
      // Every record in a real snapshot should convert and propagate.
      expect(ok, `${g.id}: ${ok}/${raw.length} converted`).toBe(raw.length);
    }
  });

  it('the default group is a bundled mix, never a live-only group', () => {
    const bundled = new Set(groups.map((g: { id: string }) => g.id));
    // The default is a pseudo-group that merges bundled snapshots.
    expect(DEFAULT_GROUP).toBe('traffic-mix');
    const liveOnly = CATALOG_GROUPS.filter((g) => !bundled.has(g.id)).map((g) => g.id);
    expect(liveOnly).toEqual(expect.arrayContaining(['active', 'starlink']));
  });
});
