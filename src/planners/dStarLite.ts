/**
 * D* Lite (Koenig & Likhachev, 2002) on a time-expanded orbital occupancy graph.
 *
 * This is the *dynamic* experiment and is intentionally separate from the five
 * static algorithms. It is an educational model of incremental replanning, not a
 * spacecraft autopilot and not conjunction assessment.
 *
 * The graph is explicitly time-expanded:
 *   node  = (cell, t)   where a cell is an (altitude band, azimuth sector,
 *                       polar sector) triple in an Earth-centred frame
 *   edge  = (cell, t) → (cell', t+1) for spatial neighbours, plus a "wait" edge
 *   GOAL  = a virtual node entered from any time step of the goal cell
 *
 * Costs are time-varying: an edge that ends in a cell occupied by a propagated
 * catalog object (inflated by a keep-out radius) at the *next* time step carries
 * a penalty. Because occupancy depends on t, the same pair of cells has a
 * different cost at different times — that is what makes the graph dynamic.
 *
 * Objects that follow their published elements move deterministically; the
 * simulation additionally re-propagates the neighbourhood every step, and any
 * object that has been given a (documented, seeded) manoeuvre perturbation
 * changes the predicted occupancy of later steps. Those cost changes are what
 * D* Lite repairs incrementally.
 */

import { Vector3D } from '../data/types';
import { EARTH_RADIUS_KM } from '../orbit/sgp4';

export interface OrbitGridSpec {
  /** Number of altitude bands. */
  altBands: number;
  /** Number of azimuth sectors (0–360°). */
  azSectors: number;
  /** Number of polar sectors (−90°…+90°). */
  polarSectors: number;
  /** Number of time steps in the rollout horizon. */
  timeSteps: number;
  /** Length of one time step, seconds. */
  stepSec: number;
  /** Keep-out radius applied around each propagated object, km. */
  keepOutKm: number;
}

export const DEFAULT_GRID: OrbitGridSpec = {
  altBands: 9,
  azSectors: 20,
  polarSectors: 7,
  timeSteps: 36,
  stepSec: 300,
  keepOutKm: 60,
};

/** Altitude band edges, km (log-spaced from LEO to just above GEO). */
const ALT_EDGES = [200, 600, 1_400, 3_200, 7_000, 14_000, 22_000, 34_000, 37_500, 45_000];

export interface PlannerEvent {
  type: 'initial' | 'cell-cost-changed' | 'replan' | 'advance' | 'goal' | 'no-path';
  timeSec: number;
  message: string;
  changedEdges?: number;
  expandedInRepair?: number;
  pathCost?: number;
}

export interface DStarSnapshot {
  grid: OrbitGridSpec;
  /** Occupancy per time step: blocked cell keys. */
  blocked: string[][];
  seed: number;
  /** Simulation epoch the snapshot was taken at (Unix ms). */
  epochMs: number;
  /** How many simulation steps had elapsed when the snapshot was taken. */
  step: number;
  manoeuvre: { noradId: number; step: number; dvKms: Vector3D }[];
}

export interface DStarStepReport {
  timeSec: number;
  nodeId: string;
  /** Total D* Lite repairs performed so far. */
  replans: number;
  /** Edge/cell cost changes applied in this repair. */
  changedEdges: number;
  /** Nodes expanded by ComputeShortestPath during this repair. */
  expandedInRepair: number;
  pathCost: number;
  pathLength: number;
  /** Wall-clock cost of the repair, ms. */
  wallMs: number;
}

const nodeId = (t: number, a: number, az: number, p: number) => `${t}:${a}:${az}:${p}`;

/** Altitude band containing `alt`, clamped to the valid range. */
function altBand(alt: number): number {
  for (let i = 0; i < ALT_EDGES.length - 1; i++) {
    if (alt < ALT_EDGES[i + 1]) return i;
  }
  return ALT_EDGES.length - 2;
}

function altOfBand(band: number): number {
  return (ALT_EDGES[band] + ALT_EDGES[band + 1]) / 2;
}

/** Cell centre in Earth-centred km for the grid. */
export function cellCentre(grid: OrbitGridSpec, a: number, az: number, p: number): Vector3D {
  const alt = altOfBand(a);
  const r = EARTH_RADIUS_KM + alt;
  const azRad = ((az + 0.5) / grid.azSectors) * Math.PI * 2;
  const polRad = ((p + 0.5) / grid.polarSectors - 0.5) * Math.PI;
  const cp = Math.cos(polRad);
  return { x: r * cp * Math.cos(azRad), y: r * Math.sin(polRad), z: r * cp * Math.sin(azRad) };
}

/** Grid cell containing an Earth-centred km position (null when out of range). */
export function cellOf(grid: OrbitGridSpec, pos: Vector3D): [number, number, number] | null {
  const r = Math.hypot(pos.x, pos.y, pos.z);
  const alt = r - EARTH_RADIUS_KM;
  if (alt < ALT_EDGES[0] || alt > ALT_EDGES[ALT_EDGES.length - 1]) return null;
  const a = altBand(alt);
  let az = Math.floor((Math.atan2(pos.z, pos.x) / (Math.PI * 2) + 1) * grid.azSectors) % grid.azSectors;
  if (az < 0) az += grid.azSectors;
  const polRad = Math.asin(Math.max(-1, Math.min(1, pos.y / r)));
  const p = Math.floor((polRad / Math.PI + 0.5) * grid.polarSectors);
  return [a, az, Math.max(0, Math.min(grid.polarSectors - 1, p))];
}

/** Deterministic 32-bit PRNG (mulberry32) so replays are reproducible. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Key = [number, number];

class KeyHeap {
  private items: { id: string; k: Key }[] = [];
  /** Membership set so stale heap entries can be skipped (lazy deletion). */
  readonly members = new Set<string>();
  get size(): number {
    return this.items.length;
  }
  private less(a: Key, b: Key): boolean {
    return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  }
  insert(id: string, k: Key): void {
    this.members.add(id);
    const a = this.items;
    a.push({ id, k });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i].k, a[p].k)) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  peek(): { id: string; k: Key } | undefined {
    while (this.items.length > 0 && !this.members.has(this.items[0].id)) this.popRaw();
    return this.items[0];
  }
  pop(): { id: string; k: Key } | undefined {
    const top = this.peek();
    if (!top) return undefined;
    this.members.delete(top.id);
    this.popRaw();
    return top;
  }
  private popRaw(): void {
    const a = this.items;
    if (a.length === 0) return;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l].k, a[m].k)) m = l;
        if (r < a.length && this.less(a[r].k, a[m].k)) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
  }
  clear(): void {
    this.items.length = 0;
    this.members.clear();
  }
}

export interface DStarOptions {
  grid?: Partial<OrbitGridSpec>;
  /** Seed for the reproducible manoeuvre perturbations. */
  seed?: number;
  /** Number of objects designated as manoeuvring. */
  manoeuvringCount?: number;
  /** Probability per step that a manoeuvring object changes course. */
  manoeuvreProbability?: number;
  /** Cost charged for waiting one time step in place. */
  waitCost?: number;
  /** Cost charged per kilometre of travel (base edge cost). */
  costPerKm?: number;
  /** Penalty for entering a cell occupied at the arrival time step. */
  occupancyPenalty?: number;
}

export class DStarLite {
  readonly grid: OrbitGridSpec;
  private readonly seed: number;
  private readonly manoeuvringCount: number;
  private readonly manoeuvreProbability: number;
  private readonly waitCost: number;
  private readonly costPerKm: number;
  private readonly occupancyPenalty: number;

  /** blocked[t] = Set of occupied cell keys at time step t. */
  private blocked: Set<string>[] = [];
  private g = new Map<string, number>();
  private rhs = new Map<string, number>();
  private U = new KeyHeap();
  /** Debug counters (exposed for tests and profiling). */
  public debug = { pops: 0, reins: 0, expanded: 0, maxU: 0 };
  private km = 0;
  private sStart = '';
  private goalCell: [number, number, number] | null = null;
  private sGoal = 'GOAL';

  private events: PlannerEvent[] = [];
  private replans = 0;
  private rng: () => number;
  private manoeuvres: { noradId: number; step: number; dvKms: Vector3D }[] = [];
  private perturbed = new Map<number, Vector3D>();
  /** Semantic map from cell key → occupancy cost currently in force. */
  private occupancyCost = new Map<string, number>();
  private currentStep = 0;

  constructor(opts: DStarOptions = {}) {
    this.grid = { ...DEFAULT_GRID, ...opts.grid };
    this.seed = opts.seed ?? 20261015;
    this.manoeuvringCount = opts.manoeuvringCount ?? 3;
    this.manoeuvreProbability = opts.manoeuvreProbability ?? 0.12;
    this.waitCost = opts.waitCost ?? 12;
    this.costPerKm = opts.costPerKm ?? 0.02;
    this.occupancyPenalty = opts.occupancyPenalty ?? 5000;
    this.rng = mulberry32(this.seed);
    for (let t = 0; t < this.grid.timeSteps; t++) this.blocked.push(new Set());
  }

  get events_(): PlannerEvent[] {
    return this.events;
  }

  get replanCount(): number {
    return this.replans;
  }

  reset(): void {
    this.g.clear();
    this.rhs.clear();
    this.U.clear();
    this.debug = { pops: 0, reins: 0, expanded: 0, maxU: 0 };
    this.km = 0;
    this.events = [];
    this.replans = 0;
    this.rng = mulberry32(this.seed);
    this.manoeuvres = [];
    this.perturbed.clear();
    this.occupancyCost.clear();
    this.currentStep = 0;
    for (const s of this.blocked) s.clear();
  }

  // ── occupancy ───────────────────────────────────────────────────────────────

  /** Apply an occupancy snapshot for time step `t`; returns the changed cells. */
  setOccupancy(t: number, positions: { noradId: number; name: string; positionKm: Vector3D }[]): string[] {
    const next = new Set<string>();
    const w = this.grid.keepOutKm;
    for (const o of positions) {
      const cell = cellOf(this.grid, o.positionKm);
      if (!cell) continue;
      next.add(cell.join(':'));
      // Inflate by neighbouring cells whose centre is within the keep-out.
      for (let da = -1; da <= 1; da++) {
        for (let daz = -1; daz <= 1; daz++) {
          for (let dp = -1; dp <= 1; dp++) {
            const a = cell[0] + da;
            const az = (cell[1] + daz + this.grid.azSectors) % this.grid.azSectors;
            const p = cell[2] + dp;
            if (a < 0 || a >= this.grid.altBands) continue;
            if (p < 0 || p >= this.grid.polarSectors) continue;
            const c = cellCentre(this.grid, a, az, p);
            const d = Math.hypot(
              c.x - o.positionKm.x,
              c.y - o.positionKm.y,
              c.z - o.positionKm.z,
            );
            if (d <= w) next.add(`${a}:${az}:${p}`);
          }
        }
      }
    }
    const prev = this.blocked[Math.max(0, Math.min(this.grid.timeSteps - 1, t))];
    const changed: string[] = [];
    for (const k of next) if (!prev.has(k)) changed.push(k);
    for (const k of prev) if (!next.has(k)) changed.push(k);
    this.blocked[Math.max(0, Math.min(this.grid.timeSteps - 1, t))] = next;
    return changed;
  }

  /** Snapshot of the current occupancy map (for the replay manifest). */
  snapshot(): DStarSnapshot {
    return {
      grid: { ...this.grid },
      blocked: this.blocked.map((s) => [...s]),
      seed: this.seed,
      epochMs: this.epochMs,
      step: this.currentStep,
      manoeuvre: this.manoeuvres.map((m) => ({ ...m })),
    };
  }

  /** Simulation epoch this instance was built for (set by the caller). */
  epochMs = 0;

  restore(snap: DStarSnapshot): void {
    // Restores the *data* layers and re-seeds the PRNG so a replay from the
    // same snapshot reproduces the same future manoeuvre perturbations. The
    // search state is left alone: `plan()` reinitialises it.
    this.blocked = snap.blocked.map((s) => new Set(s));
    this.manoeuvres = snap.manoeuvre.map((m) => ({ ...m }));
    this.perturbed.clear();
    for (const m of this.manoeuvres) this.perturbed.set(m.noradId, m.dvKms);
    this.rng = mulberry32(this.seed);
  }

  /** Draw this step's manoeuvre perturbations (deterministic given the seed). */
  drawManoeuvres(candidates: { noradId: number; name: string }[]): { noradId: number; name: string; dvKms: Vector3D }[] {
    const out: { noradId: number; name: string; dvKms: Vector3D }[] = [];
    for (const c of candidates.slice(0, this.manoeuvringCount)) {
      if (this.rng() < this.manoeuvreProbability) {
        const dvKms = {
          x: (this.rng() - 0.5) * 0.12,
          y: (this.rng() - 0.5) * 0.12,
          z: (this.rng() - 0.5) * 0.12,
        };
        this.perturbed.set(c.noradId, dvKms);
        this.manoeuvres.push({ noradId: c.noradId, step: this.currentStep, dvKms });
        out.push({ ...c, dvKms });
      }
    }
    return out;
  }

  perturbationOf(noradId: number): Vector3D | undefined {
    return this.perturbed.get(noradId);
  }

  // ── graph access ───────────────────────────────────────────────────────────

  private successors(id: string): { to: string; cost: number }[] {
    if (id === this.sGoal) return [];
    const [ts, as, azs, ps] = id.split(':').map(Number);
    const t = ts + 1;
    const out: { to: string; cost: number }[] = [];
    if (t >= this.grid.timeSteps) return out;
    const from = cellCentre(this.grid, as, azs, ps);
    const push = (a: number, az: number, p: number) => {
      const c = cellCentre(this.grid, a, az, p);
      const d = Math.hypot(c.x - from.x, c.y - from.y, c.z - from.z);
      out.push({ to: nodeId(t, a, az, p), cost: Math.max(1, d * this.costPerKm) });
    };
    if (as + 1 < this.grid.altBands) push(as + 1, azs, ps);
    if (as - 1 >= 0) push(as - 1, azs, ps);
    if (ps + 1 < this.grid.polarSectors) push(as, azs, ps + 1);
    if (ps - 1 >= 0) push(as, azs, ps - 1);
    push(as, (azs + 1) % this.grid.azSectors, ps);
    push(as, (azs - 1 + this.grid.azSectors) % this.grid.azSectors, ps);
    // Waiting in place.
    out.push({ to: nodeId(t, as, azs, ps), cost: this.waitCost });
    // Entering the goal cell terminates the search.
    if (this.goalCell && as === this.goalCell[0] && azs === this.goalCell[1] && ps === this.goalCell[2]) {
      out.push({ to: this.sGoal, cost: 0 });
    }
    return out;
  }

  private predecessors(id: string): string[] {
    if (id === this.sGoal) {
      // Every (goalCell, t) node can enter the virtual goal node.
      if (!this.goalCell) return [];
      const out: string[] = [];
      for (let t = 0; t < this.grid.timeSteps; t++) {
        out.push(nodeId(t, this.goalCell[0], this.goalCell[1], this.goalCell[2]));
      }
      return out;
    }
    const [ts, as, azs, ps] = id.split(':').map(Number);
    const t = ts - 1;
    if (t < 0) return [];
    const out: string[] = [];
    const push = (a: number, az: number, p: number) => {
      if (a < 0 || a >= this.grid.altBands) return;
      if (p < 0 || p >= this.grid.polarSectors) return;
      out.push(nodeId(t, a, az, p));
    };
    push(as + 1, azs, ps);
    push(as - 1, azs, ps);
    push(as, azs, ps + 1);
    push(as, azs, ps - 1);
    push(as, (azs + 1) % this.grid.azSectors, ps);
    push(as, (azs - 1 + this.grid.azSectors) % this.grid.azSectors, ps);
    out.push(nodeId(t, as, azs, ps)); // wait
    return out;
  }

  /** Edge cost in force right now (depends on the arrival step's occupancy). */
  private cost(from: string, to: string): number {
    const base = this.baseCost(from, to);
    if (to === this.sGoal) return base;
    const parts = to.split(':').map(Number);
    const t = parts[0];
    if (this.blocked[Math.min(this.grid.timeSteps - 1, t)]?.has(`${parts[1]}:${parts[2]}:${parts[3]}`)) {
      return base + this.occupancyPenalty;
    }
    return base;
  }

  private baseCost(from: string, to: string): number {
    if (to === this.sGoal) return 0;
    const fp = from.split(':').map(Number);
    const tp = to.split(':').map(Number);
    if (fp[0] === tp[0]) return this.waitCost;
    if (fp[1] === tp[1] && fp[2] === tp[2] && fp[3] === tp[3]) return this.waitCost;
    const a = cellCentre(this.grid, fp[1], fp[2], fp[3]);
    const b = cellCentre(this.grid, tp[1], tp[2], tp[3]);
    const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    return Math.max(1, d * this.costPerKm);
  }

  /**
   * D* Lite key. Following Koenig & Likhachev (2002):
   *   CalculateKey(s) = [ min(g, rhs)(s) + h(s_start, s) + km ; min(g, rhs)(s) ]
   * The heuristic term is the *start-to-node* estimate, which is what makes the
   * queue expand nodes near the robot first.
   */
  private hToStart(id: string): number {
    if (id === this.sGoal) return 0;
    const p = id.split(':').map(Number);
    const sp = this.sStart.split(':').map(Number);
    const a = cellCentre(this.grid, p[1], p[2], p[3]);
    const b = cellCentre(this.grid, sp[1], sp[2], sp[3]);
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) * this.costPerKm;
  }

  private h(id: string): number {
    return this.hToStart(id);
  }

  private key(id: string): Key {
    const g = this.g.get(id) ?? Infinity;
    const rhs = this.rhs.get(id) ?? Infinity;
    const m = Math.min(g, rhs);
    return [m + this.h(id) + this.km, m];
  }

  /**
   * Prepare the search state for a new route. Only the search state and the
   * event log are cleared — the occupancy model and manoeuvre bookkeeping are
   * preserved, which is what makes `replay()` reproducible.
   */
  private initialize(startCell: [number, number, number], goalCell: [number, number, number]): void {
    this.g.clear();
    this.rhs.clear();
    this.U.clear();
    this.km = 0;
    this.events = [];
    this.replans = 0;
    this.currentStep = 0;
    this.debug = { pops: 0, reins: 0, expanded: 0, maxU: 0 };
    this.goalCell = goalCell;
    this.sStart = nodeId(0, startCell[0], startCell[1], startCell[2]);
    this.startCell = startCell;
    this.goalCellRef = goalCell;
    this.rhs.set(this.sGoal, 0);
    this.U.insert(this.sGoal, this.key(this.sGoal));
  }

  /**
   * Re-run the same scenario from a snapshot: the occupancy model, the
   * manoeuvre history and the PRNG are restored, then the route is replanned.
   * Deterministic for a given (snapshot, seed) pair.
   */
  replay(snapshot: DStarSnapshot, start: [number, number, number], goal: [number, number, number]): string[] {
    this.reset();
    this.blocked = snapshot.blocked.map((s) => new Set(s));
    this.manoeuvres = snapshot.manoeuvre.map((m) => ({ ...m }));
    this.perturbed.clear();
    for (const m of this.manoeuvres) this.perturbed.set(m.noradId, m.dvKms);
    this.rng = mulberry32(this.seed);
    return this.plan(start, goal);
  }

  private updateVertex(u: string): void {
    if (u !== this.sGoal) {
      let min = Infinity;
      for (const s of this.successors(u)) {
        min = Math.min(min, this.cost(u, s.to) + (this.g.get(s.to) ?? Infinity));
      }
      this.rhs.set(u, min);
    }
    const g = this.g.get(u) ?? Infinity;
    const rhs = this.rhs.get(u) ?? Infinity;
    if (g !== rhs) {
      if (!this.U.members.has(u)) this.U.insert(u, this.key(u));
    } else if (this.U.members.has(u)) {
      // Node became consistent; drop it from the queue.
      this.U.members.delete(u);
    }
  }

  /** D* Lite core loop. Returns the number of nodes expanded. */
  private computeShortestPath(): number {
    let expanded = 0;
    let guard = 0;
    const limit = 500_000;
    while (this.U.size > 0 && guard++ < limit) {
      const top = this.U.peek()!;
      this.debug.pops++;
      this.debug.maxU = Math.max(this.debug.maxU, this.U.size);
      const kStart = this.key(this.sStart);
      const less = top.k[0] < kStart[0] || (top.k[0] === kStart[0] && top.k[1] < kStart[1]);
      const rhsStart = this.rhs.get(this.sStart) ?? Infinity;
      const gStart = this.g.get(this.sStart) ?? Infinity;
      if (!less && rhsStart <= gStart) break;
      this.U.pop();
      const u = top.id;
      const kOld = top.k;
      const kNew = this.key(u);
      const newer = kNew[0] > kOld[0] || (kNew[0] === kOld[0] && kNew[1] > kOld[1]);
      if (newer) {
        this.debug.reins++;
        this.U.insert(u, kNew);
        continue;
      }
      const gU = this.g.get(u) ?? Infinity;
      const rhsU = this.rhs.get(u) ?? Infinity;
      if (gU === rhsU) continue; // stale duplicate of a consistent node
      this.debug.expanded++;
      expanded++;
      if (gU > rhsU) {
        this.g.set(u, rhsU);
        for (const p of this.predecessors(u)) this.updateVertex(p);
      } else {
        this.g.set(u, Infinity);
        for (const p of this.predecessors(u)) this.updateVertex(p);
        this.updateVertex(u);
      }
    }
    return expanded;
  }

  /**
   * D* Lite's queue stops before the robot's own node is expanded (its key is
   * never strictly smaller than its own calculated key). Expanding s_start is
   * always safe: it has no predecessors in a forward-only time expansion, so
   * setting g = rhs does not propagate anywhere.
   */
  private finaliseStart(): void {
    const g = this.g.get(this.sStart) ?? Infinity;
    const rhs = this.rhs.get(this.sStart) ?? Infinity;
    if (rhs < g) this.g.set(this.sStart, rhs);
  }

  /** Plan from `start` to `goal`. Returns the initial route as node ids. */
  plan(start: [number, number, number], goal: [number, number, number]): string[] {
    this.initialize(start, goal);
    const expanded = this.computeShortestPath();
    this.finaliseStart();
    const path = this.path();
    this.events.push({
      type: path.length ? 'initial' : 'no-path',
      timeSec: 0,
      message: path.length
        ? `D* Lite initial plan: ${path.length} waypoints, cost ${(this.g.get(this.sStart) ?? 0).toFixed(1)}`
        : 'D* Lite could not find an initial route — the goal cell is unreachable at this horizon.',
      expandedInRepair: expanded,
      pathCost: this.g.get(this.sStart) ?? Infinity,
    });
    return path;
  }

  path(): string[] {
    const out: string[] = [this.sStart];
    let cur = this.sStart;
    const seen = new Set<string>([cur]);
    for (let guard = 0; guard < 4000; guard++) {
      if (cur === this.sGoal) break;
      let best: string | null = null;
      let bestCost = Infinity;
      for (const s of this.successors(cur)) {
        if (s.to === this.sGoal) {
          best = s.to;
          bestCost = 0;
          break;
        }
        if (seen.has(s.to)) continue;
        const c = this.cost(cur, s.to) + (this.g.get(s.to) ?? Infinity);
        if (c < bestCost) {
          bestCost = c;
          best = s.to;
        }
      }
      if (!best || seen.has(best)) break;
      seen.add(best);
      out.push(best);
      cur = best;
    }
    return out;
  }

  pathCost(): number {
    return this.g.get(this.sStart) ?? Infinity;
  }

  /**
   * Advance one time step.
   *
   * D* Lite repairs are driven by *edge* cost changes: `changedCells` are the
   * cells whose occupancy cost has changed. Because an edge's cost is read at
   * its arrival step, the edges into (cell, t) change, so the rhs values of the
   * predecessors of those nodes are recomputed and the queue is repaired
   * incrementally — the whole graph is never re-searched.
   */
  advance(changedCells: string[]): DStarStepReport {
    const t0 = performance.now();
    const route = this.path();
    if (route.length > 1) {
      this.km += this.hToStart(route[0]);
      this.sStart = route[1];
    }
    this.currentStep++;

    let changedEdges = 0;
    const seenCells = new Set(changedCells);
    for (const cell of seenCells) {
      const [a, az, p] = cell.split(':').map(Number);
      for (let t = Math.max(0, this.currentStep); t < this.grid.timeSteps; t++) {
        const v = nodeId(t, a, az, p);
        for (const u of this.predecessors(v)) this.updateVertex(u);
        changedEdges++;
      }
    }
    if (changedEdges > 0) this.replans++;

    const expanded = this.computeShortestPath();
    this.finaliseStart();
    const cost = this.pathCost();
    this.events.push({
      type: changedEdges > 0 ? 'replan' : 'advance',
      timeSec: this.currentStep * this.grid.stepSec,
      message:
        changedEdges > 0
          ? `t+${this.currentStep}: ${changedEdges} cell cost change(s) → D* Lite repaired with ${expanded} expansion(s). Route cost ${Number.isFinite(cost) ? cost.toFixed(1) : '∞'}.`
          : `t+${this.currentStep}: no cost changes; route unchanged.`,
      changedEdges,
      expandedInRepair: expanded,
      pathCost: cost,
    });
    const path = this.path();
    return {
      timeSec: this.currentStep * this.grid.stepSec,
      nodeId: this.sStart,
      replans: this.replans,
      changedEdges,
      expandedInRepair: expanded,
      pathCost: cost,
      pathLength: path.length,
      wallMs: performance.now() - t0,
    };
  }

  /** Cell of the vehicle's current node. */
  currentCell(): [number, number, number] {
    const p = this.sStart.split(':').map(Number);
    return [p[1], p[2], p[3]];
  }

  currentStepIndex(): number {
    return this.currentStep;
  }

  /** Cells whose occupancy cost changed in the most recent repair. */
  lastChanged: string[] = [];
  private startCell: [number, number, number] = [0, 0, 0];
  private goalCellRef: [number, number, number] = [0, 0, 0];
}
