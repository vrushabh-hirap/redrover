/**
 * Mission navigation graph.
 *
 * The whole-Solar-System scene is NOT a grid maze, so path search in RedRover
 * runs on an explicitly documented, *abstract* mission graph. Every node and
 * edge below is a modelling choice, not a physical trajectory. The UI labels
 * any route found here as a "conceptual AI graph route".
 *
 * Coordinate frame
 *   ALL nodes are Earth-centred inertial kilometres. A body destination's node
 *   position is `heliocentric(body) − heliocentric(Earth)`, so a lunar node sits
 *   ~384,400 km from the origin and a Mars node ~2×10⁸ km out. Mixing frames
 *   would place the Earth-orbit shells next to the Sun, which is exactly the
 *   class of bug this file exists to prevent.
 *
 * Node kinds
 *   site   — a launch site on Earth's surface (lat/lon → Earth-centred km)
 *   park   — a circular parking-orbit shell at a fixed altitude
 *   moon   — a natural satellite (position from JPL Horizons, Earth-centred)
 *   body   — a planet or the Sun (position from JPL Horizons, Earth-centred)
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
  /** Earth-centred inertial kilometres. Every node, no exceptions. */
  positionKm: Vector3D;
  /** Only set for `sat` nodes. */
  noradId?: number;
  /** Only set for `park` nodes. */
  altitudeKm?: number;
  /** Lattice coordinates, only for `park` nodes (used by the heuristic). */
  lattice?: [number, number, number];
}

export interface MissionEdge {
  to: MissionNode;
  /** Impulsive Δv proxy in m/s. */
  deltaVMs: number;
  /** Transfer duration in seconds. */
  durationSec: number;
  /** Abstract conjunction/risk cost in the same units as the route cost. */
  riskCost: number;
  /** Minimum miss distance to a cataloged object along the edge, km (−1 = not screened). */
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
    description: 'cost = transfer duration (s). Coasting/phas-ing legs are modelled with fixed durations.',
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
  /** Id of the edge that came this close. */
  edge: string;
}

export interface MissionGraphOptions {
  /** Radius of the keep-out sphere around each propagated object, km. */
  keepOutKm: number;
  /** Maximum number of cataloged objects screened per edge (performance guard). */
  hazardSampleCap: number;
}

export const DEFAULT_GRAPH_OPTIONS: MissionGraphOptions = {
  keepOutKm: 75,
  hazardSampleCap: 1_200,
};

/** Keep-out radii offered in the UI. All are educational screening radii. */
export const KEEP_OUT_CHOICES = [25, 75, 150, 300] as const;

/** Parking-orbit shells offered by the graph, km altitude. */
export const PARKING_SHELLS = [250, 400, 800, 1_200, 2_000];

/** Azimuth samples used to build the shell lattice. */
const AZIMUTHS = Array.from({ length: 24 }, (_, i) => i * (360 / 24));
/** Polar (inclination-ish) samples used to build the shell lattice. */
const POLARS = [-60, -30, 0, 30, 60];

/**
 * Fixed abstract constants for legs that are not solved from two-body
 * mechanics. They are classroom-grade constants, not mission-design values.
 */
export const ABSTRACT = {
  /** Ascent + gravity/drag losses from a surface site to a 250 km shell, m/s. */
  ascentDeltaVMs: 9_400,
  ascentDurationSec: 8 * 60,
  /** Phase change inside one shell between adjacent lattice nodes, m/s. */
  phasingDeltaVMs: 55,
  phasingDurationSec: 35 * 60,
  /** Escape to the Earth–Moon / interplanetary transfer corridor, m/s. */
  translunarInjectionMs: 3_150,
  transPlanetInjectionMs: 3_600,
  transferDurationDays: { moon: 4, planet: 120 },
  /** Capture at the destination, m/s. */
  moonCaptureMs: 820,
  planetCaptureMs: 900,
  /** Rendezvous with an Earth-orbit object from the nearest shell, m/s. */
  rendezvousMs: 90,
  rendezvousDurationSec: 45 * 60,
  /** Risk penalty when an edge is inside the keep-out sphere of an object. */
  blockCost: 1e9,
  /** Risk penalty when an edge misses an object by `d` km: exp(-d/scale). */
  riskScaleKm: 90,
  riskWeight: 1_000,
} as const;

export interface MissionGraphInput {
  origin: MissionNode;
  destination: MissionNode;
  /** Earth-centred km positions of named bodies at the mission epoch. */
  bodies: Record<string, Vector3D>;
  /** SGP4 states of cataloged objects at the mission epoch, Earth-centred km. */
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
  readonly stats: { nodes: number; edges: number; screenedObjects: number; blockedEdges: number };
  /**
   * Admissibility constants, derived from the edges that were actually built so
   * the heuristic can never overestimate the cost of a real path.
   */
  readonly bounds: { minEdgeDeltaVMs: number; maxChordSpeedKmS: number };

  constructor(input: MissionGraphInput) {
    this.serial = ++graphSerial;
    const opts = { ...DEFAULT_GRAPH_OPTIONS, ...input.options };
    this.options = opts;
    this.cost = input.cost;

    const sample = input.catalogStates.slice(0, opts.hazardSampleCap);
    this.stats = { nodes: 0, edges: 0, screenedObjects: sample.length, blockedEdges: 0 };

    this.addNode(input.origin);
    this.addNode(input.destination);

    // 1. Parking shells, arranged as a (altitude, azimuth, polar) lattice.
    const shells = PARKING_SHELLS;
    for (let b = 0; b < shells.length; b++) {
      const alt = shells[b];
      const r = EARTH_RADIUS_KM + alt;
      for (let az = 0; az < AZIMUTHS.length; az++) {
        for (let p = 0; p < POLARS.length; p++) {
          const azRad = (AZIMUTHS[az] * Math.PI) / 180;
          const polRad = (POLARS[p] * Math.PI) / 180;
          const cp = Math.cos(polRad);
          this.addNode({
            id: `park:${alt}:${az}:${p}`,
            name: `Parking orbit ${alt} km · az ${AZIMUTHS[az]}° · inc ${POLARS[p]}°`,
            kind: 'park',
            altitudeKm: alt,
            lattice: [b, az, p],
            positionKm: { x: r * cp * Math.cos(azRad), y: r * Math.sin(polRad), z: r * cp * Math.sin(azRad) },
          });
        }
      }
    }

    // 2. Origin → shells.
    if (input.origin.kind === 'site') {
      for (let az = 0; az < AZIMUTHS.length; az++) {
        for (let p = 0; p < POLARS.length; p++) {
          this.addEdge(input.origin, this.node(`park:${shells[0]}:${az}:${p}`)!, ABSTRACT.ascentDeltaVMs, ABSTRACT.ascentDurationSec, sample, opts);
          this.addEdge(input.origin, this.node(`park:${shells[2]}:${az}:${p}`)!, ABSTRACT.ascentDeltaVMs + 220, ABSTRACT.ascentDurationSec + 300, sample, opts);
        }
      }
    } else if (input.origin.kind === 'park') {
      const lat = input.origin.lattice!;
      for (let az = 0; az < AZIMUTHS.length; az++) {
        this.addEdge(input.origin, this.node(`park:${shells[0]}:${az}:${lat[2]}`)!, 40, 4 * 60, sample, opts);
      }
    } else {
      for (let az = 0; az < AZIMUTHS.length; az++) {
        for (let p = 0; p < POLARS.length; p++) {
          this.addEdge(input.origin, this.node(`park:${shells[0]}:${az}:${p}`)!, 150, 10 * 60, sample, opts);
          this.addEdge(input.origin, this.node(`park:${shells[3]}:${az}:${p}`)!, 1_100, 6 * 3600, sample, opts);
        }
      }
    }

    // 3. Shell ↔ shell inside the lattice.
    for (let b = 0; b < shells.length; b++) {
      for (let az = 0; az < AZIMUTHS.length; az++) {
        for (let p = 0; p < POLARS.length; p++) {
          const from = this.node(`park:${shells[b]}:${az}:${p}`)!;
          // Intra-shell phasing: adjacent azimuth, and adjacent polar.
          this.addEdge(from, this.node(`park:${shells[b]}:${(az + 1) % AZIMUTHS.length}:${p}`)!, ABSTRACT.phasingDeltaVMs, ABSTRACT.phasingDurationSec, sample, opts);
          this.addEdge(from, this.node(`park:${shells[b]}:${az}:${Math.min(POLARS.length - 1, p + 1)}`)!, ABSTRACT.phasingDeltaVMs, ABSTRACT.phasingDurationSec, sample, opts);
          // Inter-shell altitude raise.
          if (b < shells.length - 1) {
            const raise = this.node(`park:${shells[b + 1]}:${az}:${p}`)!;
            const h = hohmannDeltaV(EARTH_RADIUS_KM + shells[b], EARTH_RADIUS_KM + shells[b + 1]);
            this.addEdge(from, raise, h.totalDv * 1000, h.transferTimeSec, sample, opts);
          }
        }
      }
    }

    // 4. Destination connection.
    this.connectDestination(input.destination, sample, opts);

    this.stats.nodes = this.nodes.size;
    this.stats.edges = [...this.adjacency.values()].reduce((n, e) => n + e.length, 0);

    // Derive the admissibility constants from the edges that exist.
    let minDv = Infinity;
    let maxSpeed = 1e-9;
    for (const from of this.adjacency.keys()) {
      const a = this.nodes.get(from)!;
      for (const e of this.adjacency.get(from)!) {
        if (e.blocked) continue;
        minDv = Math.min(minDv, e.deltaVMs);
        const chord = Math.hypot(
          a.positionKm.x - e.to.positionKm.x,
          a.positionKm.y - e.to.positionKm.y,
          a.positionKm.z - e.to.positionKm.z,
        );
        if (e.durationSec > 0) maxSpeed = Math.max(maxSpeed, chord / e.durationSec);
      }
    }
    this.bounds = {
      minEdgeDeltaVMs: Number.isFinite(minDv) ? minDv : 0,
      maxChordSpeedKmS: maxSpeed,
    };
    this.version = this.buildVersion(input);
  }

  private connectDestination(
    dest: MissionNode,
    sample: { positionKm: Vector3D; name?: string; noradId?: number }[],
    opts: MissionGraphOptions,
  ): void {
    const shells = PARKING_SHELLS;
    const top = shells[shells.length - 1];
    const azSpan = AZIMUTHS.length;
    const pMid = Math.floor(POLARS.length / 2);

    if (dest.kind === 'moon' || dest.kind === 'body') {
      const dv = dest.kind === 'moon' ? ABSTRACT.translunarInjectionMs : ABSTRACT.transPlanetInjectionMs;
      const days = dest.kind === 'moon' ? ABSTRACT.transferDurationDays.moon : ABSTRACT.transferDurationDays.planet;
      for (let az = 0; az < azSpan; az++) {
        for (let p = 0; p < POLARS.length; p++) {
          // Every shell can attempt the departure leg; cost decides the winner.
          this.addEdge(this.node(`park:${top}:${az}:${p}`)!, dest, dv, days * 86_400, sample, opts);
          this.addEdge(this.node(`park:${shells[2]}:${az}:${p}`)!, dest, dv + 900, days * 86_400 * 1.25, sample, opts);
        }
      }
      return;
    }
    if (dest.kind === 'sat') {
      const alt = dest.altitudeKm ?? 420;
      const nearest = shells.reduce((a, b) => (Math.abs(b - alt) < Math.abs(a - alt) ? b : a));
      for (let az = 0; az < azSpan; az++) {
        for (let p = 0; p < POLARS.length; p++) {
          const from = this.node(`park:${nearest}:${az}:${p}`)!;
          const dDv = Math.abs(circularOrbitSpeedKmS(nearest) - circularOrbitSpeedKmS(alt)) * 1000;
          this.addEdge(from, dest, dDv + ABSTRACT.rendezvousMs, ABSTRACT.rendezvousDurationSec, sample, opts);
        }
      }
      void pMid;
      return;
    }
    // Destination is another surface site.
    for (let az = 0; az < azSpan; az++) {
      for (let p = 0; p < POLARS.length; p++) {
        this.addEdge(this.node(`park:${shells[0]}:${az}:${p}`)!, dest, ABSTRACT.ascentDeltaVMs, ABSTRACT.ascentDurationSec, sample, opts);
      }
    }
  }

  private buildVersion(input: MissionGraphInput): string {
    return [
      `graph#${this.serial}`,
      `origin=${input.origin.id}`,
      `dest=${input.destination.id}`,
      `cost=${this.cost.id}`,
      `keepout=${this.options.keepOutKm}km`,
      `shells=${PARKING_SHELLS.join('/')}`,
      `lattice=${AZIMUTHS.length}x${POLARS.length}`,
      `hazardSample=${this.stats.screenedObjects}`,
      `blocked=${this.stats.blockedEdges}`,
    ].join(' · ');
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

  /**
   * Screen an edge against the propagated catalog. This is a coarse educational
   * screen: the straight chord midpoint is compared with each object. It is not
   * a conjunction assessment.
   */
  private addEdge(
    from: MissionNode,
    to: MissionNode,
    deltaVMs: number,
    durationSec: number,
    sample: { positionKm: Vector3D; name?: string; noradId?: number }[],
    opts: MissionGraphOptions,
  ): void {
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
          closestName = o.name ?? `#${o.noradId ?? '?'}`;
        }
      }
    }
    const blocked = Number.isFinite(minMiss) && minMiss < opts.keepOutKm;
    if (blocked) this.stats.blockedEdges++;
    const risk = blocked
      ? ABSTRACT.blockCost
      : Number.isFinite(minMiss)
        ? ABSTRACT.riskWeight * Math.exp(-minMiss / ABSTRACT.riskScaleKm)
        : 0;
    if (Number.isFinite(minMiss) && minMiss < opts.keepOutKm * 4 && this.hazards.length < 400) {
      this.hazards.push({
        positionKm: mid,
        name: closestName,
        missDistanceKm: minMiss,
        edge: `${from.id} → ${to.id}`,
      });
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

  /**
   * A lower bound on the number of edges still to traverse. Each lattice edge
   * changes exactly one of (altitude band, azimuth index, polar index) by one,
   * and every other edge kind reaches a shell or the destination directly, so
   * the Manhattan distance over the lattice is a valid bound.
   */
  /** Public wrapper for the hop lower bound (used by the heuristic). */
  hopBound(node: MissionNode, goal: MissionNode): number {
    return this.hopLowerBound(node, goal);
  }

  private hopLowerBound(node: MissionNode, goal: MissionNode): number {
    if (node.id === goal.id) return 0;
    if (node.lattice && goal.lattice) {
      const db = Math.abs(node.lattice[0] - goal.lattice[0]);
      const dAz = Math.abs(node.lattice[1] - goal.lattice[1]);
      const azWrap = Math.min(dAz, AZIMUTHS.length - dAz);
      const dp = Math.abs(node.lattice[2] - goal.lattice[2]);
      return db + azWrap + dp;
    }
    // Crossing between a lattice node and a non-lattice node (a site, an orbit
    // object or a body) always costs at least one edge.
    return 1;
  }
}

/**
 * Admissible and consistent heuristic for the mission graph.
 *
 * Both terms are lower bounds on the corresponding cost component of *any* path
 * from `node` to `goal`, so the weighted sum is a lower bound on the total:
 *
 *   Δv   ≥ minEdgeΔv · hopLowerBound      (every edge costs at least the minimum,
 *                                           and at least that many edges remain)
 *   time ≥ chord(node, goal) / maxChordSpeed
 *                                      (the sum of chord lengths along a path is
 *                                       at least the straight-line distance, and
 *                                       no leg travels faster than the fastest
 *                                       leg in this graph)
 *   risk ≥ 0
 *
 * Note this deliberately does NOT use the classic |v_circ(r₁) − v_circ(r₂)| bound:
 * that bound describes a Hohmann transfer between two circular orbits around the
 * same primary, which the graph's constant departure/capture legs are cheaper
 * than. Using it would make A* inadmissible on this graph.
 */
export function heuristic(node: MissionNode, goal: MissionNode, cost: CostModel, graph?: MissionGraph): number {
  if (node.id === goal.id) return 0;
  const bounds = graph?.bounds ?? { minEdgeDeltaVMs: 0, maxChordSpeedKmS: Infinity };
  const d = Math.hypot(
    node.positionKm.x - goal.positionKm.x,
    node.positionKm.y - goal.positionKm.y,
    node.positionKm.z - goal.positionKm.z,
  );
  const timeBound = bounds.maxChordSpeedKmS > 0 ? d / bounds.maxChordSpeedKmS : 0;
  const dvBound = bounds.minEdgeDeltaVMs * (graph?.hopBound(node, goal) ?? 0);
  return cost.wFuel * dvBound + cost.wTime * timeBound;
}

/** Surface site → Earth-centred inertial position, km. */
export function sitePositionKm(latDeg: number, lonDeg: number, altitudeKm = 0): Vector3D {
  const la = (latDeg * Math.PI) / 180;
  const lo = (lonDeg * Math.PI) / 180;
  const r = EARTH_RADIUS_KM + altitudeKm;
  return { x: r * Math.cos(la) * Math.cos(lo), y: r * Math.sin(la), z: r * Math.cos(la) * Math.sin(lo) };
}
