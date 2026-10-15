/**
 * OMM (Orbit Mean-elements Message) → TLE conversion.
 *
 * CelesTrak's GP catalog is published as OMM JSON. SGP4 propagators
 * (satellite.js included) consume classic two-line element sets, so the mean
 * elements are converted here using the OMM ↔ TLE field definitions documented
 * by the CCSDS OMM standard and CelesTrak's GP data formats page:
 *
 *   https://celestrak.org/NORAD/documentation/gp-data-formats.php
 *
 * Field-mapping notes (these are the details that are easy to get wrong):
 *   OMM MEAN_MOTION_DOT   → TLE cols 34-43 (already ṅ/2, rev/day²)
 *   OMM MEAN_MOTION_DDOT  → TLE cols 45-52 (already n̈/6, rev/day³)
 *   OMM BSTAR             → TLE cols 54-61 (B* drag term, exponential form)
 *   OMM ECCENTRICITY      → TLE cols 27-33 (leading decimal point implied)
 *
 * Every line is check-summed with the standard TLE modulo-10 rule so the output
 * is a well-formed element set that satellite.js can parse.
 */

export interface OmmRecord {
  OBJECT_NAME?: string;
  OBJECT_ID?: string;
  EPOCH?: string;
  MEAN_MOTION?: string | number;
  ECCENTRICITY?: string | number;
  INCLINATION?: string | number;
  RA_OF_ASC_NODE?: string | number;
  ARG_OF_PERICENTER?: string | number;
  MEAN_ANOMALY?: string | number;
  EPHEMERIS_TYPE?: number;
  CLASSIFICATION_TYPE?: string;
  NORAD_CAT_ID?: string | number;
  ELEMENT_SET_NO?: number;
  REV_AT_EPOCH?: number;
  BSTAR?: string | number;
  MEAN_MOTION_DOT?: string | number;
  MEAN_MOTION_DDOT?: string | number;
}

/** TLE check-sum: digits sum, '-' counts as 1, modulo 10. */
export function tleChecksum(line: string): number {
  let sum = 0;
  for (const ch of line) {
    if (ch >= '0' && ch <= '9') sum += ch.charCodeAt(0) - 48;
    else if (ch === '-') sum += 1;
  }
  return sum % 10;
}

function num(v: string | number | undefined, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Fractional day-of-year and 2-digit year from an ISO-8601 timestamp. */
export function epochToDayOfYear(iso: string): { yy: number; doy: number } {
  // OMM EPOCH values from CelesTrak are UTC but may omit the zone designator;
  // a missing "Z" would make the JS Date constructor assume local time.
  const raw = iso.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const d = new Date(hasZone ? raw : `${raw}Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid OMM EPOCH: ${iso}`);
  const startOfYear = Date.UTC(d.getUTCFullYear(), 0, 1);
  const doy = (d.getTime() - startOfYear) / 86_400_000 + 1;
  return { yy: d.getUTCFullYear() % 100, doy };
}

/** Fixed-point with `dec` decimals, right-justified in `width`. */
function fixed(value: number, width: number, dec: number): string {
  let s = Math.abs(value).toFixed(dec);
  if (s.length > width) s = s.slice(0, width);
  const sign = value < 0 ? '-' : ' ';
  return (sign + s).padStart(width, ' ').slice(-width);
}

/**
 * Exponential TLE form (mantissa normalised to [0.1, 1), 5 significant digits):
 *   1.2830727e-4 → " 12831-4"
 *   0            → " 00000+0"
 * The sign character is the sign of the *exponent*, not of the value.
 */
export function exponential(value: number, width = 8): string {
  if (value === 0 || !Number.isFinite(value)) return ' '.repeat(width - 7) + '00000+0';
  let exp = Math.floor(Math.log10(Math.abs(value))) + 1;
  let digits = Math.round((Math.abs(value) / Math.pow(10, exp)) * 1e5);
  if (digits >= 100000) {
    digits = Math.round(digits / 10);
    exp += 1;
  }
  const s = `${String(digits).padStart(5, '0')}${exp < 0 ? '-' : '+'}${Math.abs(exp)}`;
  return s.padStart(width, ' ').slice(-width);
}

/**
 * First-derivative field: sign, implied decimal point, 8 digits.
 *   6.592e-5 → " .00006592"
 */
export function firstDerivative(value: number): string {
  if (value === 0 || !Number.isFinite(value)) return ' ' + '.00000000';
  const sign = value < 0 ? '-' : ' ';
  const digits = (Math.abs(value) * 1e8).toFixed(0).padStart(8, '0').slice(-8);
  return `${sign}.${digits}`;
}

/** International designator "1998-067A" → "98067A  ". */
export function internationalDesignator(objectId: string | undefined): string {
  if (!objectId) return '99999A  ';
  const m = /^(\d{4})-(\d{3})(.*)$/.exec(objectId.trim());
  if (!m) return '99999A  ';
  const yy = m[1].slice(2);
  const num = m[2];
  const piece = (m[3] || 'A').trim().slice(0, 3).padEnd(3, ' ');
  return `${yy}${num}${piece}`;
}

/**
 * Convert a CelesTrak OMM record to a two-line element set.
 * Throws when the record lacks the elements needed for propagation.
 */
export function ommToTle(o: OmmRecord): { line1: string; line2: string } {
  if (o.NORAD_CAT_ID === undefined || o.NORAD_CAT_ID === '') {
    throw new Error('OMM record is missing NORAD_CAT_ID');
  }
  const catId = String(o.NORAD_CAT_ID).trim().padStart(5, '0').slice(-5);
  const classification = (o.CLASSIFICATION_TYPE || 'U').trim()[0] || 'U';
  const { yy, doy } = epochToDayOfYear(o.EPOCH ?? '');

  const ndot = num(o.MEAN_MOTION_DOT, 0);
  const nddot = num(o.MEAN_MOTION_DDOT, 0);
  const bstar = num(o.BSTAR, 0);
  const ephType = o.EPHEMERIS_TYPE ?? 0;
  const elsetNo = o.ELEMENT_SET_NO ?? 999;
  const revNo = o.REV_AT_EPOCH ?? 0;

  const l1body =
    `1 ${catId}${classification} ` +
    internationalDesignator(o.OBJECT_ID) +
    ` ${String(yy).padStart(2, '0')}${doy.toFixed(8).padStart(12, ' ')} ` +
    `${firstDerivative(ndot)} ` +
    `${exponential(nddot)} ` +
    `${exponential(bstar)} ` +
    `${ephType} ${String(elsetNo).padStart(4, ' ')}`;
  const line1 = l1body.padEnd(68, ' ') + String(tleChecksum(l1body.padEnd(68, ' ')));

  const inc = num(o.INCLINATION, 0);
  const raan = num(o.RA_OF_ASC_NODE, 0);
  const argp = num(o.ARG_OF_PERICENTER, 0);
  const ma = num(o.MEAN_ANOMALY, 0);
  const ecc = num(o.ECCENTRICITY, 0);
  const mm = num(o.MEAN_MOTION, 0);
  if (mm <= 0) throw new Error('OMM record is missing a usable MEAN_MOTION');

  const eccStr = Math.trunc(ecc * 1e7).toString().padStart(7, '0').slice(-7);
  const l2body =
    `2 ${catId} ` +
    `${fixed(inc, 8, 4)} ` +
    `${fixed(raan, 8, 4)} ` +
    `${eccStr} ` +
    `${fixed(argp, 8, 4)} ` +
    `${fixed(ma, 8, 4)} ` +
    `${fixed(mm, 11, 8)}` +
    `${String(revNo).padStart(5, ' ')}`;
  const line2 = l2body.padEnd(68, ' ') + String(tleChecksum(l2body.padEnd(68, ' ')));

  return { line1, line2 };
}
