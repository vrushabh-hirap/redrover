#!/usr/bin/env node
/**
 * RedRover — JPL Horizons snapshot builder
 *
 * Downloads real JPL Horizons ephemeris vectors (ICRF / J2000 ecliptic plane, km,
 * heliocentric for the Sun and planets, planetocentric for moons) for a
 * documented date range at a fixed step, and writes a compact, date-stamped
 * snapshot into public/data/ephemeris/ plus manifest.json.
 *
 * This produces the *bundled* (offline, reproducible) dataset. The running app
 * can always query Horizons live for an arbitrary epoch (see src/data/horizons.ts).
 *
 * Usage:
 *   node preprocessing/fetch_horizons.js [--start 2026-09-15] [--stop 2026-12-15] [--step 6h]
 *
 * Source: https://ssd-api.jpl.nasa.gov/doc/horizons.html
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../public/data/ephemeris');

const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const START = arg('start', '2026-09-15');
const STOP = arg('stop', '2026-12-15');
const STEP = arg('step', '6h');

/** id = Horizons COMMAND value; parent = Horizons id of the parent body center, if any. */
const BODIES = [
  { name: 'Sun', id: '10', parent: null },
  { name: 'Mercury', id: '199', parent: null },
  { name: 'Venus', id: '299', parent: null },
  { name: 'Earth', id: '399', parent: null },
  { name: 'Mars', id: '499', parent: null },
  { name: 'Jupiter', id: '599', parent: null },
  { name: 'Saturn', id: '699', parent: null },
  { name: 'Uranus', id: '799', parent: null },
  { name: 'Neptune', id: '899', parent: null },
  { name: 'Moon', id: '301', parent: null },
  { name: 'Io', id: '501', parent: '599' },
  { name: 'Europa', id: '502', parent: '599' },
  { name: 'Ganymede', id: '503', parent: '599' },
  { name: 'Callisto', id: '504', parent: '599' },
  { name: 'Titan', id: '606', parent: '699' },
];

async function fetchVectors(body, step, attempt = 0) {
  const params = new URLSearchParams({
    format: 'text',
    COMMAND: body.id,
    EPHEM_TYPE: 'VECTORS',
    CENTER: body.parent ? `500@${body.parent}` : '@sun',
    START_TIME: `${START} 00:00`,
    STOP_TIME: `${STOP} 00:00`,
    STEP_SIZE: step,
    VEC_TABLE: '2',
    REF_PLANE: 'ECLIPTIC',
    OUT_UNITS: 'KM-S',
    ANG_FORMAT: 'DEG',
  });
  const res = await fetch(`${API}?${params.toString()}`, { signal: AbortSignal.timeout(120_000) });
  if (res.status === 429 || res.status >= 500) {
    throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: true });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('$$SOE')) {
    throw Object.assign(new Error(`No ephemeris table for ${body.name}: ${text.slice(0, 200)}`), { retryable: true });
  }
  return text;
}

const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

/** Parse the $$SOE..$$EOE block of a Horizons vector table. */
function parseTable(text) {
  const rows = [];
  const re =
    /^\s*(-?\d+\.\d+)\s*=\s*A\.D\.\s*(\d{4})-([A-Za-z]{3})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})[^\n]*\n\s*X\s*=\s*(-?[\d.eE+]+)\s+Y\s*=\s*(-?[\d.eE+]+)\s+Z\s*=\s*(-?[\d.eE+]+)\n\s*VX\s*=\s*(-?[\d.eE+-]+)\s*VY\s*=\s*(-?[\d.eE+-]+)\s*VZ\s*=\s*(-?[\d.eE+-]+)/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const mm = MONTHS[m[3]];
    if (!mm) continue;
    rows.push({
      dateStr: `${m[2]}-${mm}-${m[4]}T${m[5]}:${m[6]}:${m[7]}Z`,
      r: [parseFloat(m[8]), parseFloat(m[9]), parseFloat(m[10])],
      v: [parseFloat(m[11]), parseFloat(m[12]), parseFloat(m[13])],
    });
  }
  return rows;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const retrievedAt = new Date().toISOString();
  const raw = {};
  for (const b of BODIES) {
    let text = null;
    for (let attempt = 0; attempt < 6 && text === null; attempt++) {
      try {
        text = await fetchVectors(b, STEP);
      } catch (err) {
        if (!err.retryable || attempt === 5) throw err;
        const wait = 3000 * (attempt + 1);
        console.log(`  … ${b.name}: ${err.message}; retrying in ${wait} ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    const rows = parseTable(text);
    if (rows.length === 0) throw new Error(`No rows parsed for ${b.name}`);
    raw[b.name] = { parent: b.parent, rows };
    console.log(`  ${b.name.padEnd(9)} ${String(rows.length).padStart(5)} steps  ${rows[0].dateStr} → ${rows[rows.length - 1].dateStr}`);
    await new Promise((r) => setTimeout(r, 1200));
  }

  const base = raw['Sun'].rows.map((r) => r.dateStr);
  const byTime = new Map(base.map((t) => [t, {}]));
  const seen = new Set();
  for (const [name, entry] of Object.entries(raw)) {
    for (const row of entry.rows) {
      const slot = byTime.get(row.dateStr);
      if (!slot) continue;
      slot[name] = { r: row.r, v: row.v, parent: entry.parent };
      seen.add(row.dateStr);
    }
  }

  const idToName = new Map(BODIES.map((b) => [b.id, b.name]));
  const times = [];
  const positions = {};
  const velocities = {};
  for (const b of BODIES) {
    positions[b.name] = [];
    velocities[b.name] = [];
  }

  for (const t of byTime.keys()) {
    const slot = byTime.get(t);
    for (const name of Object.keys(slot)) {
      if (!slot[name].parent) {
        positions[name].push(slot[name].r);
        velocities[name].push(slot[name].v);
      }
    }
    for (const name of Object.keys(slot)) {
      const e = slot[name];
      if (!e.parent) continue;
      const pName = idToName.get(e.parent);
      const pi = positions[pName].length - 1;
      const vi = velocities[pName].length - 1;
      positions[name].push([
        positions[pName][pi][0] + e.r[0],
        positions[pName][pi][1] + e.r[1],
        positions[pName][pi][2] + e.r[2],
      ]);
      velocities[name].push([
        velocities[pName][vi][0] + e.v[0],
        velocities[pName][vi][1] + e.v[1],
        velocities[pName][vi][2] + e.v[2],
      ]);
    }
    times.push(t);
  }

  const r1 = (v) => Math.round(v * 1000) / 1000;
  const r1e = (v) => Math.round(v * 1e6) / 1e6;

  const out = {
    generatedBy: 'preprocessing/fetch_horizons.js',
    api: 'https://ssd-api.jpl.nasa.gov/doc/horizons.html',
    retrievedAt,
    requestedRange: { start: `${START}T00:00:00Z`, stop: `${STOP}T00:00:00Z`, step: STEP },
    frame: 'ICRF/J2000, ecliptic reference plane, heliocentric for the Sun and planets',
    units: { position: 'km', velocity: 'km/s' },
    bodies: BODIES.map((b) => ({
      name: b.name,
      horizonsId: b.id,
      center: b.parent ? `500@${b.parent}` : '@sun',
      parent: b.parent ? idToName.get(b.parent) : null,
    })),
    times,
    positions: Object.fromEntries(Object.entries(positions).map(([k, v]) => [k, v.map((p) => p.map(r1))])),
    velocities: Object.fromEntries(Object.entries(velocities).map(([k, v]) => [k, v.map((p) => p.map(r1e))])),
  };

  const target = path.join(OUT_DIR, 'snapshot.json');
  fs.writeFileSync(target, JSON.stringify(out));
  console.log(`\nWrote ${target} (${(fs.statSync(target).size / 1024).toFixed(0)} KB)`);
  console.log(`Steps: ${times.length}  Bodies: ${BODIES.length}  Series: ${Object.keys(seen).size}`);

  const manifest = {
    generatedAt: retrievedAt,
    generator: 'preprocessing/fetch_horizons.js',
    bundles: [
      {
        id: 'horizons-default',
        file: 'snapshot.json',
        provider: 'NASA/JPL Horizons System (vector ephemerides)',
        api: 'https://ssd-api.jpl.nasa.gov/doc/horizons.html',
        retrievedAt,
        requestedRange: out.requestedRange,
        step: STEP,
        frame: out.frame,
        units: out.units,
        bodies: out.bodies.map((b) => b.name),
        steps: times.length,
      },
    ],
  };
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('Wrote manifest.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
