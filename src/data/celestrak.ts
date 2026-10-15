/**
 * Earth-orbit catalog access (CelesTrak General Perturbations data).
 *
 * Provider chain: CelesTrak (https://celestrak.org) republishes General
 * Perturbations element sets that originate from the US Space Force /
 * Space-Track catalog. This is **not** NASA data and the UI says so.
 *
 * Format: OMM JSON (see https://celestrak.org/NORAD/documentation/gp-data-formats.php).
 * Elements are converted to classic two-line element sets by `./ommToTle` and
 * propagated with SGP4 (satellite.js) in the TEME frame.
 *
 * Two modes:
 *   live    — query CelesTrak now (rate-limited; may fail, then we fall back)
 *   bundled — read the dated snapshot shipped in public/data/catalog/
 *
 * The catalog only contains *tracked* objects. Untracked small debris has no
 * public per-object position and is never invented here. See DATA_SOURCES.md.
 */

import { CatalogObject, OrbitalObjectType } from './types';
import { OmmRecord, ommToTle } from './ommToTle';

export interface CatalogGroupDef {
  id: string;
  label: string;
  description: string;
  url: string;
  /** Rough expected size; used only for UI hints. */
  approxObjects: string;
}

/** Groups verified to exist on CelesTrak's GP endpoint (HTTP 200 + JSON array). */
/** Pseudo-groups that merge bundled snapshots (see loadBundledCatalog). */
export interface CatalogMixDef {
  id: string;
  label: string;
  description: string;
  approxObjects: string;
}

export const CATALOG_MIX_DEFS: CatalogMixDef[] = [
  {
    id: 'traffic-mix',
    label: 'LEO traffic mix',
    description: 'Stations + last-30-day launches + Iridium 33 debris (real CelesTrak snapshot).',
    approxObjects: '~375',
  },
  {
    id: 'debris-mix',
    label: 'Breakup debris',
    description: 'Tracked fragments of the Iridium 33 / Cosmos 2251 and Fengyun-1C breakups.',
    approxObjects: '~2,600',
  },
];

export const CATALOG_GROUPS: CatalogGroupDef[] = [
  {
    id: 'stations',
    label: 'Stations',
    description: 'Crewed and cargo stations (ISS, CSS/Tiangong) and visiting vehicles.',
    url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json',
    approxObjects: '~20',
  },
  {
    id: 'last-30-days',
    label: 'Last 30 days',
    description: 'Objects launched in the last 30 days (payloads and rocket bodies).',
    url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=last-30-days&FORMAT=json',
    approxObjects: '~250',
  },
  {
    id: 'iridium-33-debris',
    label: 'Iridium 33 debris',
    description: 'Tracked fragments from the 2009 Iridium 33 / Cosmos 2251 collision.',
    url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=iridium-33-debris&FORMAT=json',
    approxObjects: '~110',
  },
  {
    id: 'cosmos-2251-debris',
    label: 'Cosmos 2251 debris',
    description: 'Tracked fragments from the 2009 Iridium 33 / Cosmos 2251 collision.',
    url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=cosmos-2251-debris&FORMAT=json',
    approxObjects: '~600',
  },
  {
    id: 'fengyun-1c-debris',
    label: 'Fengyun-1C debris',
    description: 'Tracked fragments from the 2007 Fengyun-1C anti-satellite breakup.',
    url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=fengyun-1c-debris&FORMAT=json',
    approxObjects: '~2,000',
  },
  {
    id: 'active',
    label: 'Active payloads',
    description: 'All currently active payloads (live only; not bundled).',
    url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json',
    approxObjects: '~9,000',
  },
  {
    id: 'starlink',
    label: 'Starlink',
    description: 'Starlink constellation (live only; not bundled).',
    url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=json',
    approxObjects: '~9,000',
  },
];

export const DEFAULT_GROUP = 'traffic-mix';

export type CatalogStatusKind = 'live' | 'bundled' | 'unavailable' | 'user-upload';

export interface CatalogStatus {
  kind: CatalogStatusKind;
  provider: string;
  group: string;
  groupLabel: string;
  retrievedAt: string;
  elementEpochRange: string;
  objectCount: number;
  /** True when the requested simulation time is more than `staleAfterDays` from the newest element epoch. */
  detail: string;
}

export interface CatalogResult {
  objects: CatalogObject[];
  status: CatalogStatus;
}

const BASE = import.meta.env.BASE_URL;

/**
 * Object classification. CelesTrak's GP/JSON format does not publish a
 * per-object TYPE field, so the type is derived from the requesting group and
 * the object name. This is a documented heuristic — see DATA_SOURCES.md.
 */
export function classifyObject(name: string, group: string): OrbitalObjectType {
  const u = name.toUpperCase();
  const isDebrisGroup = group.toLowerCase().includes('debris');
  if (isDebrisGroup) {
    // The parent object of a breakup group is the intact spacecraft.
    const parent = group.replace(/-debris$/i, '').replace(/-/g, ' ').toUpperCase();
    const uTrim = u.replace(/\s*\(.*\)\s*$/, '');
    if (!/DEB|FRAG|RK|R\/B/.test(u) && (uTrim === parent || uTrim.startsWith(parent))) {
      return 'payload';
    }
    return 'debris';
  }
  if (/\bR\/B\b|ROCKET BODY|ROCKET/.test(u)) return 'rocket_body';
  if (/DEB|FRAG/.test(u)) return 'debris';
  return 'payload';
}

const MU_EARTH = 398_600.4418;

function ommToObject(o: OmmRecord, group: string): CatalogObject | null {
  try {
    const noradId = Number(o.NORAD_CAT_ID);
    if (!Number.isFinite(noradId) || noradId <= 0) return null;
    const { line1, line2 } = ommToTle(o);
    const mm = Number(o.MEAN_MOTION);
    if (!Number.isFinite(mm) || mm <= 0) return null;
    const n = (mm * 2 * Math.PI) / 86_400;
    const altitudeKm = Math.max(120, Math.cbrt(MU_EARTH / (n * n)) - 6378.137);
    const epochIso = normaliseEpoch(o.EPOCH ?? '');
    return {
      noradId,
      name: (o.OBJECT_NAME ?? `NORAD ${noradId}`).trim(),
      type: classifyObject(o.OBJECT_NAME ?? '', group),
      line1,
      line2,
      inclinationDeg: Number(o.INCLINATION) || 0,
      altitudeKm,
      periodMin: 1440 / mm,
      epochIso,
      objectId: o.OBJECT_ID ?? '',
    };
  } catch {
    return null;
  }
}

/** CelesTrak omits the zone designator; both forms are UTC. */
function normaliseEpoch(raw: string): string {
  const s = raw.trim();
  if (!s) return new Date(0).toISOString();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const d = new Date(hasZone ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

function epochRange(objects: CatalogObject[]): string {
  const ts = objects.map((o) => Date.parse(o.epochIso)).filter((t) => Number.isFinite(t) && t > 0);
  if (ts.length === 0) return 'unknown';
  const min = new Date(Math.min(...ts));
  const max = new Date(Math.max(...ts));
  const fmt = (d: Date) => d.toISOString().slice(0, 16) + 'Z';
  return `${fmt(min)} → ${fmt(max)}`;
}

export function groupLabel(group: string): string {
  if (BUNDLED_MIXES[group]) return BUNDLED_MIXES[group].label;
  return CATALOG_GROUPS.find((g) => g.id === group)?.label ?? group;
}

function statusOf(
  kind: CatalogStatusKind,
  group: string,
  objects: CatalogObject[],
  retrievedAt: string,
  detail: string,
): CatalogStatus {
  const def = CATALOG_GROUPS.find((g) => g.id === group);
  return {
    kind,
    provider:
      kind === 'user-upload'
        ? 'User-uploaded element set'
        : 'CelesTrak (elements originate from the US Space Force / Space-Track catalog)',
    group,
    groupLabel: groupLabel(group),
    retrievedAt,
    elementEpochRange: epochRange(objects),
    objectCount: objects.length,
    detail,
  };
}

/** Bundled snapshot groups (shipped in public/data/catalog). */
const BUNDLED_GROUPS = CATALOG_GROUPS.filter(
  (g) => g.id !== 'active' && g.id !== 'starlink',
).map((g) => g.id);

/**
 * Pseudo-groups that merge several bundled snapshots into one catalog. They are
 * offered first so the default view carries a meaningful, real object set.
 */
export const BUNDLED_MIXES: Record<string, { label: string; description: string; groups: string[] }> = {
  'traffic-mix': {
    label: 'LEO traffic mix',
    description: 'Stations + last-30-day launches + Iridium 33 debris (real CelesTrak snapshot).',
    groups: ['stations', 'last-30-days', 'iridium-33-debris'],
  },
  'debris-mix': {
    label: 'Breakup debris',
    description: 'Tracked fragments of the Iridium 33 / Cosmos 2251 and Fengyun-1C breakups.',
    groups: ['iridium-33-debris', 'cosmos-2251-debris', 'fengyun-1c-debris'],
  },
};


/**
 * Load the bundled snapshot for a group. The bundled files are exactly what
 * CelesTrak returned on `snapshotRetrievedAt`, so replays are deterministic.
 */
export async function loadBundledCatalog(group: string = DEFAULT_GROUP): Promise<CatalogResult> {
  if (BUNDLED_MIXES[group]) {
    const mix = BUNDLED_MIXES[group];
    const seen = new Set<number>();
    const objects: CatalogObject[] = [];
    const parts: string[] = [];
    for (const g of mix.groups) {
      if (!BUNDLED_GROUPS.includes(g)) continue;
      const res = await fetch(`${BASE}data/catalog/${g}.json`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status} for bundled catalog ${g}`);
      const raw = (await res.json()) as OmmRecord[];
      const parsed = raw
        .map((o) => ommToObject(o, g))
        .filter((o): o is CatalogObject => !!o && !seen.has(o.noradId));
      for (const o of parsed) seen.add(o.noradId);
      objects.push(...parsed);
      parts.push(`${g} (${parsed.length})`);
    }
    if (objects.length === 0) throw new Error(`No objects in bundled mix "${group}"`);
    return {
      objects,
      status: statusOf(
        'bundled',
        group,
        objects,
        new Date().toISOString(),
        `Bundled CelesTrak snapshot: ${parts.join(' + ')} objects, de-duplicated by NORAD id. Deterministic for replay.`,
      ),
    };
  }
  if (!BUNDLED_GROUPS.includes(group)) {
    throw new Error(`No bundled snapshot for group "${group}"; use the live query.`);
  }
  const res = await fetch(`${BASE}data/catalog/${group}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for bundled catalog ${group}`);
  const raw = (await res.json()) as OmmRecord[];
  const objects = raw.map((o) => ommToObject(o, group)).filter((o): o is CatalogObject => !!o);
  const retrievedAt = new Date().toISOString();
  return {
    objects,
    status: statusOf(
      'bundled',
      group,
      objects,
      retrievedAt,
      'Bundled snapshot fetched from CelesTrak when the repository dataset was generated; deterministic for replay.',
    ),
  };
}

/**
 * Query CelesTrak live. Never resolves to synthetic data: on failure it
 * throws and the caller keeps whatever it already had, with an explanation.
 */
export async function fetchLiveCatalog(group: string = DEFAULT_GROUP): Promise<CatalogResult> {
  const def = CATALOG_GROUPS.find((g) => g.id === group) ?? CATALOG_GROUPS[0];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(def.url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as OmmRecord[];
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('Empty or malformed response');
    const objects = raw.map((o) => ommToObject(o, group)).filter((o): o is CatalogObject => !!o);
    if (objects.length === 0) throw new Error('No usable OMM records in response');
    return {
      objects,
      status: statusOf(
        'live',
        group,
        objects,
        new Date().toISOString(),
        'Live CelesTrak query. Element epochs are per object; SGP4 accuracy degrades beyond roughly ±7 days of each element epoch.',
      ),
    };
  } catch (err) {
    throw new Error(
      `Live CelesTrak query failed: ${String(err)}. The previous catalog is still in use; you can retry or switch to the bundled snapshot.`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Parse a user-supplied TLE / OMM file. */
export function parseUserElements(text: string, label = 'user file'): CatalogResult {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const objects: CatalogObject[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('1 ') && lines[i + 1]?.startsWith('2 ')) {
      const l1 = lines[i];
      const l2 = lines[i + 1];
      i += 1;
      const noradId = parseInt(l2.slice(2, 7).trim(), 10);
      if (!Number.isFinite(noradId)) continue;
      const inc = parseFloat(l2.slice(8, 16)) || 0;
      const mm = parseFloat(l2.slice(52, 63)) || 0;
      if (mm <= 0) continue;
      const n = (mm * 2 * Math.PI) / 86_400;
      const alt = Math.max(120, Math.cbrt(MU_EARTH / (n * n)) - 6378.137);
      const nameGuess = lines[i - 1] && !lines[i - 1].startsWith('1 ') && !lines[i - 1].startsWith('2 ') ? lines[i - 1] : `NORAD ${noradId}`;
      objects.push({
        noradId,
        name: nameGuess.trim(),
        type: classifyObject(nameGuess, label),
        line1: l1,
        line2: l2,
        inclinationDeg: inc,
        altitudeKm: alt,
        periodMin: 1440 / mm,
        epochIso: epochFromTle(l1),
        objectId: '',
      });
    }
  }
  return {
    objects,
    status: statusOf(
      'user-upload',
      label,
      objects,
      new Date().toISOString(),
      'User-uploaded element set. Verify provider, epoch and coordinate frame before use.',
    ),
  };
}

function epochFromTle(line1: string): string {
  // Epoch: 2-digit year + fractional day of year at columns 19-32.
  const yy = parseInt(line1.slice(18, 20), 10);
  const doy = parseFloat(line1.slice(20, 32));
  if (!Number.isFinite(yy) || !Number.isFinite(doy)) return new Date(0).toISOString();
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const ms = Date.UTC(year, 0, 1) + (doy - 1) * 86_400_000;
  return new Date(ms).toISOString();
}

/** Newest element epoch in a set, as Unix ms (0 when unknown). */
export function newestElementEpoch(objects: CatalogObject[]): number {
  let max = 0;
  for (const o of objects) {
    const t = Date.parse(o.epochIso);
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}
