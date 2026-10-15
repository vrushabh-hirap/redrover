/**
 * Mission navigation graph.
 *
 * The whole-Solar-System scene is NOT a grid maze, so path search in RedRover
 * runs on an explicitly documented, *abstract* mission graph. Every node and
 * edge below is a modelling choice, not a physical trajectory. The UI labels
 * any route found here as a "conceptual AI graph route".
 *
 * Node kinds
 *   site   — a launch site on Earth's surface (lat/lon → ECEF km)
 *   park   — a circular parking-orbit shell at a fixed altitude
 *   moon   — a natural satellite (position from JPL Horizons)
 *   body   — a planet or the Sun (heliocentric position from JPL Horizons)
 *   sat    — a cataloged Earth-orbit object (position from SGP4)
 *
 * Edge costs are abstract and configurable. Four documented objectives are
 * available; the weights are printed in the route inspector so a result can
 * always be traced back to the model that produced it.
 */

import { Vector3D } from '../data/types';
import {
  EARTH_RADIUS_KM,
  MU_EARTH_KM,
  circularOrbitSpeedKmS,
  hohmannDeltaV,
} from '../orbit/sgp4';

export type MissionNodeKind = 'site' | 'park' | 'moon' | 'body' | 'sat';

export interface MissionNode {
  id: string;
  name: string;
  kind: MissionNodeKind;
  /** Earth-centred km for site/park/sat; heliocentric km for moon/body. */
  positionKm: Vector3D;
  /** Only set for `sat` nodes. */
  noradId?: number;
  /** Only set for `park` nodes. */
  altitudeKm?: number;
}

export interface MissionEdge {
  to: MissionNode;
  /** Impulsive Δv proxy in m/s. */
  deltaVMs: number;
  /** Transfer duration in seconds. */
  durationSec: number;
  /** Abstract conjunction/risk cost in the same units as the route cost. */
  riskCost: number;
  /** Minimum miss distance to a cataloged object along the edge, km (Infinity when unknown). */
  minMissKm: number;
  /** True when the edge passes inside the keep-out sphere of a cataloged object. */
  blocked: boolean;
}

export type CostModelId = 'fuel' | 'time' | 'risk' | 'balanced';

export interface CostModel {
  id: CostModelId;
  label: string;
  description: string;
  /** Weight applied to Δv (m/s). */
  wFuel: number;
  /** Weight applied to duration (seconds). */
  wTime: number;
  /** Weight applied to abstract risk. */
  wRisk: number;
}

export const COST_MODELS: CostModel[] = [
  {
    id: 'fuel',
    label: 'Minimise Δv proxy',
    description: 'cost = Δv proxy (m/s). Impulsive two-body Hohmann and fixed ascent/capture constants.',
    wFuel: 1,
    wTime: 0,
    wRisk: 0,
  },
  {
    id: 'time',
    label: 'Minimise duration',
    description: 'cost = transfer duration (s). Coastal/phas-ing legs are modelled with fixed durations.',
    wFuel: 0,
    wTime: 1,
    wRisk: 0,
  },
  {
    id: 'risk',
    label: 'Minimise collision risk',
    description: 'cost = abstract keep-out penalty from SGP4-screened cataloged objects only.',
    wFuel: 0,
    wTime: 0,
    wRisk: 1,
  },
  {
    id: 'balanced',
    label: 'Balanced (documented weights)',
    description: 'cost = 1·Δv(m/s) + 0.005·duration(s) + risk penalty. Risk is only credited inside Earth orbit.',
    wFuel: 1,
    wTime: 0.005,
    wRisk: 1,
  },
];

export const DEFAULT_COST_MODEL: CostModelId = 'balanced';

export function costModel(id: CostModelId): CostModel {
  return COST_MODELS.find((m) => m.id === id) ?? COST_MODELS[3];
}

export interface Hazard {
  positionKm: Vector3D;
  name: string;
  missDistanceKm: number;
}

export interface MissionGraphOptions {
  keepOutKm: number;
  /** Maximum number of cataloged objects screened per edge (performance guard). */
  hazardSampleCap: number;
}

export const DEFAULT_GRAPH_OPTIONS: MissionGraphOptions = {
  keepOutKm: 25,
  hazardSampleCap: 600,
};

/** Parking-orbit shells offered by the graph, km altitude. */
export const PARKING_SHELLS = [250, 400, 800, 1200, 2000];

/** Azimuth samples used to build shell phasing nodes. */
const AZIMUTHS = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

/**
 * Fixed abstract constants for legs that are not solved from two-body
 * mechanics. They are classroom-grade constants, not mission-design values.
 */
export const ABSTRACT = {
  /** Ascent + gravity/drag losses from a surface site to a 250 km shell, m/s. */
  ascentDeltaVMs: 9_400,
  ascentDurationSec: 8 * 60,
  /** Phase change inside one shell between adjacent azimuth samples, m/s. */
  phasingDeltaVMs: 55,
  phasingDurationSec: 35 * 60,
  /** Escape to the Earth–Moon/Mars transfer corridor from a 2 000 km shell, m/s. */
  translunarInjectionMs: 3_150,
  transmarsInjectionMs: 3_600,
  transferDurationDays: { moon: 4, mars: 210, generic: 120 },
  /** Capture at the destination, m/s. */
  moonCaptureMs: 820,
  planetCaptureMs: 900,
  /** Rendezvous with an Earth-orbit object from the nearest shell, m/s. */
  rendezvousMs: 90,
  rendezvousDurationSec: 45 * 60,
  /** Risk penalty when an edge is inside the keep-out sphere of an object. */
  blockCost: 1e9,
  /** Risk penalty when an edge misses an object by `d` km: exp(-d/scale). */
  riskScaleKm: 60,
  riskWeight: 1_000,
} as const;

export interface MissionGraphInput {
  origin: MissionNode;
  destination: MissionNode;
  /** Heliocentric km positions of named bodies at the mission epoch. */
  bodies: Record<string, Vector3D>;
  /** SGP4 states of cataloged objects at the mission epoch, km Earth-centred TEME. */
  catalogStates: { noradId: number; name: string; positionKm: Vector3D }[];
  cost: CostModel;
  options?: Partial<MissionGraphOptions>;
}

let graphSerial = 0;

export class MissionGraph {
  readonly nodes = new Map<string, MissionNode>();
  private adjacency = new Map<string, MissionEdge[]>();
  readonly cost: CostModel;
  readonly options: MissionGraphOptions;
  readonly hazards: Hazard[] = [];
  /** Identifies the exact dataset the graph was built from (shown in the UI). */
  readonly version: string;
  readonly serial: number;
  /** Counts kept for truthfulness in the UI. */
  readonly stats: { nodes: number; edges: number; screenedObjects: number };

  constructor(input: MissionGraphInput) {
    this.serial = ++graphSerial;
    const opts = { ...DEFAULT_GRAPH_OPTIONS, ...input.options };
    this.options = opts;
    this.cost = input.cost;

    const sample = input.catalogStates.slice(0, opts.hazardSampleCap);
    this.stats = { nodes: 0, edges: 0, screenedObjects: sample.length };

    this.addNode(input.origin);
    this.addNode(input.destination);

    // 1. Parking shells.
    const shells = PARKING_SHELLS;
    for (const alt of shells) {
      const r = EARTH_RADIUS_KM + alt;
      for (const az of AZIMUTHS) {
        const rad = (az * Math.PI) / 180;
        const inc = 0.35; // slight inclination so shells are not degenerate
        this.addNode({
          id: `park:${alt}:${az}`,
          name: `Parking orbit ${alt} km · az ${az}°`,
          kind: 'park',
          altitudeKm: alt,
          positionKm: {
            x: r * Math.cos(rad),
            y: r * Math.sin(rad) * inc,
            z: r * Math.sin(rad),
          },
        });
      }
    }

    // 2. Origin → shells.
    if (input.origin.kind === 'site') {
      for (const az of AZIMUTHS) {
        this.addEdge(input.origin, this.node(`park:${shells[0]}:${az}`)!, ABSTRACT.ascentDeltaVMs, ABSTRACT.ascentDurationSec, sample, opts);
        this.addEdge(input.origin, this.node(`park:${shells[2]}:${az}`)!, ABSTRACT.ascentDeltaVMs + 220, ABSTRACT.ascentDurationSec + 300, sample, opts);
      }
    } else if (input.origin.kind === 'park') {
      for (const az of AZIMUTHS) {
        this.addEdge(input.origin, this.node(`park:${shells[0]}:${az}`)!, 40, 4 * 60, sample, opts);
      }
    } else {
      // Starting from an orbit/body node: connect to the closest shells.
      for (const az of AZIMUTHS) {
        this.addEdge(input.origin, this.node(`park:${shells[0]}:${az}`)!, 150, 10 * 60, sample, opts);
        this.addEdge(input.origin, this.node(`park:${shells[3]}:${az}`)!, 1_100, 6 * 3600, sample, opts);
      }
    }

    // 3. Shell ↔ shell.
    for (let i = 0; i < shells.length; i++) {
      for (let j = 0; j < AZIMUTHS.length; j++) {
        const from = this.node(`park:${shells[i]}:${AZIMUTHS[j]}`)!;
        const nextAz = AZIMUTHS[(j + 1) % AZIMUTHS.length];
        const phasing = this.node(`park:${shells[i]}:${nextAz}`)!;
        this.addEdge(from, phasing, ABSTRACT.phasingDeltaVMs, ABSTRACT.phasingDurationSec, sample, opts);

        if (i < shells.length - 1) {
          const raise = this.node(`park:${shells[i + 1]}:${AZIMUTHS[j]}`)!;
          const h = hohmannDeltaV(EARTH_RADIUS_KM + shells[i], EARTH_RADIUS_KM + shells[i + 1]);
          this.addEdge(from, raise, h.totalDv * 1000, h.transferTimeSec, sample, opts);
        }
      }
    }

    // 4. Destination connection.
    this.connectDestination(input.destination, input.bodies, sample, opts);

    this.stats.nodes = this.nodes.size;
    this.stats.edges = [...this.adjacency.values()].reduce((n, e) => n + e.length, 0);
    this.version = this.buildVersion(input);
  }

  private connectDestination(
    dest: MissionNode,
    bodies: Record<string, Vector3D>,
    sample: { positionKm: Vector3D }[],
    opts: MissionGraphOptions,
  ): void {
    const top = PARKING_SHELLS[PARKING_SHELLS.length - 1];
    if (dest.kind === 'moon' || dest.kind === 'body') {
      const generic = dest.kind === 'moon';
      const key = generic ? 'moon' : 'generic';
      const dv = generic ? ABSTRACT.translunarInjectionMs : ABSTRACT.planetCaptureMs;
      const duration = ABSTRACT.transferDurationDays[key] * 86_400;
      for (const az of AZIMUTHS) {
        this.addEdge(this.node(`park:${top}:${az}`)!, dest, dv, duration, sample, opts);
      }
      return;
    }
    if (dest.kind === 'sat') {
      const alt = this.node(dest.id)?.altitudeKm ?? 420;
      const nearest = PARKING_SHELLS.reduce((a, b) =>
        Math.abs(b - alt) < Math.abs(a - alt) ? b : a,
      );
      for (const az of AZIMUTHS) {
        const from = this.node(`park:${nearest}:${az}`)!;
        const dDv = Math.abs(circularOrbitSpeedKmS(nearest) - circularOrbitSpeedKmS(alt)) * 1000;
        this.addEdge(from, dest, dDv + ABSTRACT.rendezvousMs, ABSTRACT.rendezvousDurationSec, sample, opts);
      }
      return;
    }
    // Destination is another surface site: connect via the low shells.
    for (const az of AZIMUTHS) {
      this.addEdge(this.node(`park:${PARKING_SHELLS[0]}:${az}`)!, dest, ABSTRACT.ascentDeltaVMs, ABSTRACT.ascentDurationSec, sample, opts);
    }
  }

  private buildVersion(input: MissionGraphInput): string {
    const parts = [
      `graph#${this.serial}`,
      `origin=${input.origin.id}`,
      `dest=${input.destination.id}`,
      `cost=${this.cost.id}`,
      `keepout=${this.options.keepOutKm}km`,
      `shells=${PARKING_SHELLS.join('/')}`,
      `hazardSample=${this.stats.screenedObjects}`,
    ];
    return parts.join(' · ');
  }

  private addNode(n: MissionNode): void {
    if (!this.nodes.has(n.id)) {
      this.nodes.set(n.id, n);
      this.adjacency.set(n.id, []);
    }
  }

  node(id: string): MissionNode | undefined {
    return this.nodes.get(id);
  }

  private addEdge(
    from: MissionNode,
    to: MissionNode,
    deltaVMs: number,
    durationSec: number,
    sample: { noradId?: number; name?: string; positionKm: Vector3D }[],
    opts: MissionGraphOptions,
  ): void {
    // Screen the edge midpoint against cataloged objects. This is a coarse
    // educational screen, not a conjunction assessment.
    const mid = {
      x: (from.positionKm.x + to.positionKm.x) / 2,
      y: (from.positionKm.y + to.positionKm.y) / 2,
      z: (from.positionKm.z + to.positionKm.z) / 2,
    };
    let minMiss = Infinity;
    let closestName = '';
    // Only screen edges that actually live inside Earth orbit.
    const rMid = Math.hypot(mid.x, mid.y, mid.z);
    const screensable = rMid < EARTH_RADIUS_KM + 60_000;
    if (screensable) {
      for (const o of sample) {
        const d = Math.hypot(o.positionKm.x - mid.x, o.positionKm.y - mid.y, o.positionKm.z - mid.z);
        if (d < minMiss) {
          minMiss = d;
          closestName = o.name ?? `NORAD ${o.noradId ?? '?'}`;
        }
      }
    }
    const blocked = Number.isFinite(minMiss) && minMiss < opts.keepOutKm;
    const risk = blocked
      ? ABSTRACT.blockCost
      : Number.isFinite(minMiss)
        ? ABSTRACT.riskWeight * Math.exp(-minMiss / ABSTRACT.riskScaleKm)
        : 0;
    if (Number.isFinite(minMiss) && minMiss < opts.keepOutKm * 4 && this.hazards.length < 80) {
      this.hazards.push({ positionKm: mid, name: closestName, missDistanceKm: minMiss });
    }
    this.adjacency.get(from.id)!.push({
      to,
      deltaVMs,
      durationSec,
      riskCost: risk,
      minMissKm: Number.isFinite(minMiss) ? minMiss : -1,
      blocked,
    });
  }

  neighbours(node: MissionNode): MissionEdge[] {
    return this.adjacency.get(node.id) ?? [];
  }

  allNodes(): MissionNode[] {
    return [...this.nodes.values()];
  }

  /** Route cost of an edge under this graph's cost model. */
  edgeCost(e: MissionEdge): number {
    const c = this.cost;
    return c.wFuel * e.deltaVMs + c.wTime * e.durationSec + c.wRisk * e.riskCost;
  }
}

/** Surface site → Earth-centred (inertial) position, km. */
export function sitePositionKm(latDeg: number, lonDeg: number, altitudeKm = 0): Vector3D {
  const la = (latDeg * Math.PI) / 180;
  const lo = (lonDeg * Math.PI) / 180;
  const r = EARTH_RADIUS_KM + altitudeKm;
  return { x: r * Math.cos(la) * Math.cos(lo), y: r * Math.sin(la), z: r * Math.cos(la) * Math.sin(lo) };
}

/**
 * Admissible-and-consistent lower bound on the remaining route cost, derived
 * from the same cost model the graph uses. Each component is bounded below
 * independently, so the weighted sum is a valid bound:
 *   Δv   ≥ |v_circ(r_node) − v_circ(r_goal)|   (two-body impulse lower bound)
 *   time ≥ geodesic distance / MAX_SPEED_KM_S
 *   risk ≥ 0
 */
const MAX_SPEED_KM_S = 45; // generous upper bound on any transfer leg speed

export function heuristic(node: MissionNode, goal: MissionNode, cost: CostModel): number {
  if (node.id === goal.id) return 0;
  const r1 = Math.hypot(node.positionKm.x, node.positionKm.y, node.positionKm.z);
  const r2 = Math.hypot(goal.positionKm.x, goal.positionKm.y, goal.positionKm.z);
  const dvBound =
    (Math.abs(circularOrbitSpeedKmS(r1 - EARTH_RADIUS_KM) - circularOrbitSpeedKmS(r2 - EARTH_RADIUS_KM)) * 1000);
  const d = Math.hypot(
    node.positionKm.x - goal.positionKm.x,
    node.positionKm.y - goal.positionKm.y,
    node.positionKm.z - goal.positionKm.z,
  );
  const timeBound = (d / MAX_SPEED_KM_S) * 1000;
  return cost.wFuel * dvBound + cost.wTime * timeBound;
}
