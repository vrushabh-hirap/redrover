#!/usr/bin/env node
/**
 * RedRover — CelesTrak catalog snapshot builder.
 *
 * Downloads the General Perturbations (OMM JSON) records for a documented set
 * of groups and writes them, verbatim, into public/data/catalog/ together with
 * a manifest.json that records the retrieval time, the provider chain and each
 * group's object count and element-epoch range.
 *
 * These files are the app's *bundled* (offline, reproducible) dataset. The
 * running app can also query CelesTrak live.
 *
 * Usage:
 *   node preprocessing/fetch_catalog.js [--groups stations,last-30-days]
 *
 * Sources:
 *   https://celestrak.org/NORAD/documentation/gp-data-formats.php
 *   (underlying provider: US Space Force / Space-Track)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../public/data/catalog');

/** Bundled groups. `active` and `starlink` are deliberately live-only. */
const GROUPS = [
  { id: 'stations', url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json' },
  { id: 'last-30-days', url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=last-30-days&FORMAT=json' },
  { id: 'iridium-33-debris', url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=iridium-33-debris&FORMAT=json' },
  { id: 'cosmos-2251-debris', url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=cosmos-2251-debris&FORMAT=json' },
  { id: 'fengyun-1c-debris', url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=fengyun-1c-debris&FORMAT=json' },
];

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

async function fetchGroup(entry, attempt = 0) {
  const res = await fetch(entry.url, { signal: AbortSignal.timeout(60_000) });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 5) throw new Error(`${entry.id}: HTTP ${res.status} after retries`);
    const wait = 4_000 * (attempt + 1);
    console.log(`  … ${entry.id}: HTTP ${res.status}; retrying in ${wait} ms`);
    await new Promise((r) => setTimeout(r, wait));
    return fetchGroup(entry, attempt + 1);
  }
  if (!res.ok) throw new Error(`${entry.id}: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error(`${entry.id}: empty or malformed response`);
  return data;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const requested = String(arg('groups', GROUPS.map((g) => g.id).join(',')))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const retrievedAt = new Date().toISOString();
  const outGroups = [];

  for (const entry of GROUPS) {
    if (!requested.includes(entry.id)) continue;
    let data;
    try {
      data = await fetchGroup(entry);
    } catch (err) {
      console.error(`  ✗ ${entry.id}: ${err.message}`);
      continue;
    }
    const file = `${entry.id}.json`;
    fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify(data));
    const epochs = data.map((o) => o.EPOCH).filter(Boolean).sort();
    outGroups.push({
      id: entry.id,
      file,
      url: entry.url,
      objectCount: data.length,
      elementEpochRange: epochs.length ? `${epochs[0]} → ${epochs[epochs.length - 1]}` : 'unknown',
    });
    console.log(`  ✓ ${entry.id.padEnd(20)} ${String(data.length).padStart(5)} objects → ${file}`);
    await new Promise((r) => setTimeout(r, 1_200));
  }

  if (outGroups.length === 0) {
    console.error('No groups were downloaded; manifest not written.');
    process.exit(1);
  }

  const manifest = {
    generatedAt: retrievedAt,
    generator: 'preprocessing/fetch_catalog.js',
    provider: 'CelesTrak (elements originate from the US Space Force / Space-Track General Perturbations catalog)',
    providerUrl: 'https://celestrak.org/NORAD/elements/gp.php',
    formatDocumentation: 'https://celestrak.org/NORAD/documentation/gp-data-formats.php',
    coordinateFrame: 'TEME (True Equator, Mean Equinox) — SGP4 propagation frame',
    propagator: 'SGP4 via satellite.js',
    usefulRange: 'positions degrade beyond roughly ±7 days from each object element epoch',
    groups: outGroups,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const total = outGroups.reduce((n, g) => n + g.objectCount, 0);
  console.log(`\nWrote manifest.json · ${outGroups.length} groups · ${total} objects · retrieved ${retrievedAt}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
