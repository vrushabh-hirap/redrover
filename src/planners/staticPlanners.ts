/**
 * Static graph search algorithms over the mission navigation graph.
 *
 * All five algorithms from the course syllabus share one graph instance and one
 * cost model, so their results are directly comparable. Each implementation is
 * the textbook algorithm — they are not relabelled variants of one another.
 */

import { MissionEdge, MissionGraph, MissionNode, heuristic } from '../core/missionGraph';

export type AlgorithmId = 'bfs' | 'dfs' | 'ucs' | 'greedy' | 'astar';

export interface AlgorithmMeta {
  id: AlgorithmId;
  label: string;
  short: string;
  optimality: string;
  notes: string;
}

export const ALGORITHMS: Record<AlgorithmId, AlgorithmMeta> = {
  bfs: {
    id: 'bfs',
    label: 'Breadth-First Search',
    short: 'BFS',
    optimality: 'Optimal only when every edge has equal cost.',
    notes:
      'Expands the shallowest node first, ignoring cost. On this graph it minimises the number of transfer stages, not Δv or duration.',
  },
  dfs: {
    id: 'dfs',
    label: 'Depth-First Search',
    short: 'DFS',
    optimality: 'No optimality guarantee.',
    notes: 'Dives down one branch as far as it can before backtracking. Included as a traversal baseline.',
  },
  ucs: {
    id: 'ucs',
    label: 'Uniform Cost Search',
    short: 'UCS',
    optimality: 'Optimal for non-negative edge costs.',
    notes: 'Dijkstra search on the accumulated route cost. On this graph it returns the cheapest route for the selected cost model.',
  },
  greedy: {
    id: 'greedy',
    label: 'Greedy Best-First Search',
    short: 'Greedy',
    optimality: 'Not guaranteed optimal.',
    notes: 'Orders the frontier by the heuristic alone. Usually fast, frequently more expensive than optimal.',
  },
  astar: {
    id: 'astar',
    label: 'A*',
    short: 'A*',
    optimality: 'Optimal and efficient when h(n) is admissible and consistent.',
    notes:
      'f(n) = g(n) + h(n). h is the cost-model-consistent lower bound in missionGraph.heuristic(), built from two-body Δv and a speed-capped time bound.',
  },
};

export const ALGORITHM_ORDER: AlgorithmId[] = ['bfs', 'dfs', 'ucs', 'greedy', 'astar'];

export interface PlanMetrics {
  algorithm: string;
  found: boolean;
  /** Route cost under the selected cost model. */
  pathCost: number;
  /** Sum of the Δv proxy along the route, m/s. */
  deltaVTotalMs: number;
  durationHours: number;
  expandedNodes: number;
  peakFrontier: number;
  planningTimeMs: number;
  edgeCount: number;
  minMissKm: number;
  /** True when no edge of the route is flagged as blocked. */
  clearedObstacles: boolean;
  /** How many edges of the route were rejected by keep-out screening. */
  blockedEdgesSkipped: number;
  optimality: string;
}

export interface PlanResult {
  algorithm: AlgorithmId;
  path: MissionNode[];
  explored: MissionNode[];
  metrics: PlanMetrics;
  found: boolean;
  /** Cost model and graph version the result belongs to. */
  graphVersion: string;
}

// ─────────────────────────────────────────────────────────────────────────────

function reconstruct(parent: Map<string, MissionNode>, start: MissionNode, goal: MissionNode): MissionNode[] {
  const path: MissionNode[] = [];
  let cur: MissionNode | undefined = goal;
  let guard = 0;
  while (cur && guard++ < 100_000) {
    path.push(cur);
    if (cur.id === start.id) break;
    cur = parent.get(cur.id);
  }
  return path.reverse();
}

function metricsOf(
  graph: MissionGraph,
  path: MissionNode[],
  expanded: number,
  peak: number,
  ms: number,
  algo: AlgorithmId,
): PlanMetrics {
  let cost = 0;
  let dv = 0;
  let dur = 0;
  let minMiss = Infinity;
  let cleared = true;
  for (let i = 0; i < path.length - 1; i++) {
    const e = graph.neighbours(path[i]).find((x) => x.to.id === path[i + 1].id);
    if (!e) continue;
    cost += graph.edgeCost(e);
    dv += e.deltaVMs;
    dur += e.durationSec;
    if (e.minMissKm >= 0 && e.minMissKm < minMiss) minMiss = e.minMissKm;
    if (e.blocked) cleared = false;
  }
  const reachable = path.length >= 2;
  return {
    algorithm: ALGORITHMS[algo].label,
    found: reachable,
    pathCost: reachable ? Number(cost.toFixed(2)) : Infinity,
    deltaVTotalMs: Math.round(dv),
    durationHours: Number((dur / 3600).toFixed(2)),
    expandedNodes: expanded,
    peakFrontier: peak,
    planningTimeMs: Number(ms.toFixed(3)),
    edgeCount: Math.max(0, path.length - 1),
    minMissKm: minMiss === Infinity ? -1 : Number(minMiss.toFixed(1)),
    clearedObstacles: reachable && cleared,
    blockedEdgesSkipped: graph.stats.blockedEdges,
    optimality: ALGORITHMS[algo].optimality,
  };
}

function emptyResult(graph: MissionGraph, algo: AlgorithmId): PlanResult {
  return {
    algorithm: algo,
    path: [],
    explored: [],
    found: false,
    graphVersion: graph.version,
    metrics: {
      algorithm: ALGORITHMS[algo].label,
      found: false,
      pathCost: Infinity,
      deltaVTotalMs: 0,
      durationHours: 0,
      expandedNodes: 0,
      peakFrontier: 0,
      planningTimeMs: 0,
      edgeCount: 0,
      minMissKm: -1,
      clearedObstacles: false,
      blockedEdgesSkipped: 0,
      optimality: ALGORITHMS[algo].optimality,
    },
  };
}

/** Binary heap keyed by a comparator; small and dependency-free. */
class Heap<T> {
  private items: T[] = [];
  constructor(private cmp: (a: T, b: T) => number) {}
  get size(): number {
    return this.items.length;
  }
  push(v: T): void {
    const a = this.items;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

const byKey = (key: (n: MissionNode) => [number, number]) => (a: MissionNode, b: MissionNode) => {
  const ka = key(a);
  const kb = key(b);
  return ka[0] - kb[0] || ka[1] - kb[1];
};

// ─────────────────────────────────────────────────────────────────────────────

export function planAStar(graph: MissionGraph, start: MissionNode, goal: MissionNode): PlanResult {
  const t0 = performance.now();
  const h = (n: MissionNode) => heuristic(n, goal, graph.cost, graph);
  const g = new Map<string, number>([[start.id, 0]]);
  const parent = new Map<string, MissionNode>();
  const closed = new Set<string>();
  const explored: MissionNode[] = [];
  const open = new Heap<MissionNode>(byKey((n) => [g.get(n.id)! + h(n), 0]));
  open.push(start);
  let peak = open.size;
  let found = false;

  while (open.size > 0) {
    peak = Math.max(peak, open.size);
    const cur = open.pop()!;
    if (closed.has(cur.id)) continue;
    closed.add(cur.id);
    explored.push(cur);
    if (cur.id === goal.id) {
      found = true;
      break;
    }
    const gCur = g.get(cur.id)!;
    for (const e of graph.neighbours(cur)) {
      if (e.blocked) continue;
      const ng = gCur + graph.edgeCost(e);
      const id = e.to.id;
      if (ng < (g.get(id) ?? Infinity)) {
        g.set(id, ng);
        parent.set(id, cur);
        open.push(e.to);
      }
    }
  }
  const path = found ? reconstruct(parent, start, goal) : [];
  return {
    algorithm: 'astar',
    path,
    explored,
    found,
    graphVersion: graph.version,
    metrics: metricsOf(graph, path, explored.length, peak, performance.now() - t0, 'astar'),
  };
}

export function planUCS(graph: MissionGraph, start: MissionNode, goal: MissionNode): PlanResult {
  const t0 = performance.now();
  const g = new Map<string, number>([[start.id, 0]]);
  const parent = new Map<string, MissionNode>();
  const closed = new Set<string>();
  const explored: MissionNode[] = [];
  const open = new Heap<MissionNode>(byKey((n) => [g.get(n.id)!, 0]));
  open.push(start);
  let peak = open.size;
  let found = false;

  while (open.size > 0) {
    peak = Math.max(peak, open.size);
    const cur = open.pop()!;
    if (closed.has(cur.id)) continue;
    closed.add(cur.id);
    explored.push(cur);
    if (cur.id === goal.id) {
      found = true;
      break;
    }
    const gCur = g.get(cur.id)!;
    for (const e of graph.neighbours(cur)) {
      if (e.blocked) continue;
      const ng = gCur + graph.edgeCost(e);
      if (ng < (g.get(e.to.id) ?? Infinity)) {
        g.set(e.to.id, ng);
        parent.set(e.to.id, cur);
        open.push(e.to);
      }
    }
  }
  const path = found ? reconstruct(parent, start, goal) : [];
  return {
    algorithm: 'ucs',
    path,
    explored,
    found,
    graphVersion: graph.version,
    metrics: metricsOf(graph, path, explored.length, peak, performance.now() - t0, 'ucs'),
  };
}

export function planGreedy(graph: MissionGraph, start: MissionNode, goal: MissionNode): PlanResult {
  const t0 = performance.now();
  const h = (n: MissionNode) => heuristic(n, goal, graph.cost, graph);
  const parent = new Map<string, MissionNode>();
  const closed = new Set<string>();
  const explored: MissionNode[] = [];
  const q = new Heap<{ n: MissionNode; k: number }>((a, b) => a.k - b.k);
  q.push({ n: start, k: h(start) });
  let peak = q.size;
  let found = false;
  while (q.size > 0) {
    peak = Math.max(peak, q.size);
    const { n: cur } = q.pop()!;
    if (closed.has(cur.id)) continue;
    closed.add(cur.id);
    explored.push(cur);
    if (cur.id === goal.id) {
      found = true;
      break;
    }
    for (const e of graph.neighbours(cur)) {
      if (e.blocked) continue;
      if (closed.has(e.to.id)) continue;
      if (!parent.has(e.to.id)) parent.set(e.to.id, cur);
      q.push({ n: e.to, k: h(e.to) });
    }
  }
  const path = found ? reconstruct(parent, start, goal) : [];
  return {
    algorithm: 'greedy',
    path,
    explored,
    found,
    graphVersion: graph.version,
    metrics: metricsOf(graph, path, explored.length, peak, performance.now() - t0, 'greedy'),
  };
}

export function planBFS(graph: MissionGraph, start: MissionNode, goal: MissionNode): PlanResult {
  const t0 = performance.now();
  const parent = new Map<string, MissionNode>();
  const seen = new Set<string>([start.id]);
  const explored: MissionNode[] = [];
  const queue: MissionNode[] = [start];
  let peak = 1;
  let found = false;
  while (queue.length > 0) {
    peak = Math.max(peak, queue.length);
    const cur = queue.shift()!;
    explored.push(cur);
    if (cur.id === goal.id) {
      found = true;
      break;
    }
    for (const e of graph.neighbours(cur)) {
      if (e.blocked) continue;
      if (seen.has(e.to.id)) continue;
      seen.add(e.to.id);
      parent.set(e.to.id, cur);
      queue.push(e.to);
    }
  }
  const path = found ? reconstruct(parent, start, goal) : [];
  return {
    algorithm: 'bfs',
    path,
    explored,
    found,
    graphVersion: graph.version,
    metrics: metricsOf(graph, path, explored.length, peak, performance.now() - t0, 'bfs'),
  };
}

export function planDFS(graph: MissionGraph, start: MissionNode, goal: MissionNode): PlanResult {
  const t0 = performance.now();
  const parent = new Map<string, MissionNode>();
  const seen = new Set<string>();
  const explored: MissionNode[] = [];
  const stack: MissionNode[] = [start];
  let peak = 1;
  let found = false;
  while (stack.length > 0) {
    peak = Math.max(peak, stack.length);
    const cur = stack.pop()!;
    if (seen.has(cur.id)) continue;
    seen.add(cur.id);
    explored.push(cur);
    if (cur.id === goal.id) {
      found = true;
      break;
    }
    const edges = graph.neighbours(cur).filter((e) => !e.blocked);
    // Push in reverse so the first neighbour is explored first (deterministic).
    for (let i = edges.length - 1; i >= 0; i--) {
      const e = edges[i];
      if (seen.has(e.to.id)) continue;
      if (!parent.has(e.to.id)) parent.set(e.to.id, cur);
      stack.push(e.to);
    }
  }
  const path = found ? reconstruct(parent, start, goal) : [];
  return {
    algorithm: 'dfs',
    path,
    explored,
    found,
    graphVersion: graph.version,
    metrics: metricsOf(graph, path, explored.length, peak, performance.now() - t0, 'dfs'),
  };
}

export const PLANNERS: Record<AlgorithmId, (g: MissionGraph, s: MissionNode, t: MissionNode) => PlanResult> = {
  astar: planAStar,
  ucs: planUCS,
  greedy: planGreedy,
  bfs: planBFS,
  dfs: planDFS,
};

/** Convenience: run one algorithm. */
export function runPlan(graph: MissionGraph, algo: AlgorithmId, start: MissionNode, goal: MissionNode): PlanResult {
  return PLANNERS[algo](graph, start, goal);
}

/** Run every algorithm on the same graph instance for side-by-side comparison. */
export function runAllStatic(
  graph: MissionGraph,
  start: MissionNode,
  goal: MissionNode,
  algos: AlgorithmId[] = ALGORITHM_ORDER,
): PlanResult[] {
  return algos.map((a) => PLANNERS[a](graph, start, goal));
}

export type { MissionEdge };
