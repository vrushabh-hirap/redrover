import { GridCoord, NavGraph, PlannerResult } from '../core/types';
import { PriorityQueue, coordKey, octileDistance, parseKey } from './PriorityQueue';

export type PlannerType = 'bfs' | 'dfs' | 'ucs' | 'greedy' | 'astar';

/**
 * Reconstructs path from start to goal given the parent map
 */
function reconstructPath(parent: Map<string, string>, startKey: string, goalKey: string): GridCoord[] {
  const path: GridCoord[] = [];
  let curr: string | undefined = goalKey;
  while (curr !== undefined) {
    path.push(parseKey(curr));
    if (curr === startKey) break;
    curr = parent.get(curr);
  }
  return path.reverse();
}

/**
 * Calculates total path cost along edges of the nav graph
 */
function calculatePathCost(path: GridCoord[], graph: NavGraph): number {
  if (path.length <= 1) return 0;
  let cost = 0;
  for (let i = 0; i < path.length - 1; i++) {
    cost += graph.getCost(path[i], path[i + 1]);
  }
  return Number(cost.toFixed(3));
}

/**
 * Breadth-First Search (FIFO queue)
 * Guarantees fewest steps, but not minimal weighted cost on variable terrain.
 */
export function runBFS(graph: NavGraph, start: GridCoord, goal: GridCoord): PlannerResult {
  const startTime = performance.now();
  const startK = coordKey(start);
  const goalK = coordKey(goal);

  if (startK === goalK) {
    return {
      path: [start],
      exploredOrder: [start],
      found: true,
      metrics: {
        algorithm: 'BFS',
        pathCost: 0,
        steps: 1,
        expandedNodes: 1,
        peakFrontier: 1,
        planningTimeMs: Number((performance.now() - startTime).toFixed(2)),
        optimalityNote: 'Optimal for unweighted step count; suboptimal for terrain slope cost.',
      },
    };
  }

  const queue: GridCoord[] = [start];
  const visited = new Set<string>([startK]);
  const parent = new Map<string, string>();
  const exploredOrder: GridCoord[] = [];
  let peakFrontier = 1;
  let expandedCount = 0;
  let found = false;

  while (queue.length > 0) {
    peakFrontier = Math.max(peakFrontier, queue.length);
    const curr = queue.shift()!;
    const currK = coordKey(curr);
    exploredOrder.push(curr);
    expandedCount++;

    if (currK === goalK) {
      found = true;
      break;
    }

    for (const edge of graph.getNeighbors(curr)) {
      const nextK = coordKey(edge.target);
      if (!visited.has(nextK)) {
        visited.add(nextK);
        parent.set(nextK, currK);
        queue.push(edge.target);
      }
    }
  }

  const planningTimeMs = Number((performance.now() - startTime).toFixed(2));
  const path = found ? reconstructPath(parent, startK, goalK) : [];

  return {
    path,
    exploredOrder,
    found,
    metrics: {
      algorithm: 'BFS',
      pathCost: calculatePathCost(path, graph),
      steps: path.length,
      expandedNodes: expandedCount,
      peakFrontier,
      planningTimeMs,
      optimalityNote: 'Step-optimal only. Unaware of slope and terrain roughness.',
    },
  };
}

/**
 * Depth-First Search (LIFO stack with cycle detection)
 * Non-optimal path, exploratory nature.
 */
export function runDFS(graph: NavGraph, start: GridCoord, goal: GridCoord, maxSteps = 10000): PlannerResult {
  const startTime = performance.now();
  const startK = coordKey(start);
  const goalK = coordKey(goal);

  const stack: GridCoord[] = [start];
  const visited = new Set<string>();
  const parent = new Map<string, string>();
  const exploredOrder: GridCoord[] = [];
  let peakFrontier = 1;
  let expandedCount = 0;
  let found = false;

  while (stack.length > 0 && expandedCount < maxSteps) {
    peakFrontier = Math.max(peakFrontier, stack.length);
    const curr = stack.pop()!;
    const currK = coordKey(curr);

    if (visited.has(currK)) continue;
    visited.add(currK);
    exploredOrder.push(curr);
    expandedCount++;

    if (currK === goalK) {
      found = true;
      break;
    }

    const neighbors = graph.getNeighbors(curr);
    for (const edge of neighbors) {
      const nextK = coordKey(edge.target);
      if (!visited.has(nextK)) {
        parent.set(nextK, currK);
        stack.push(edge.target);
      }
    }
  }

  const planningTimeMs = Number((performance.now() - startTime).toFixed(2));
  const path = found ? reconstructPath(parent, startK, goalK) : [];

  return {
    path,
    exploredOrder,
    found,
    metrics: {
      algorithm: 'DFS',
      pathCost: calculatePathCost(path, graph),
      steps: path.length,
      expandedNodes: expandedCount,
      peakFrontier,
      planningTimeMs,
      optimalityNote: 'Non-optimal. Explores deeply along single branches; high path variance.',
    },
  };
}

/**
 * Uniform Cost Search (Dijkstra)
 * Explores by cumulative g(n). Guaranteed cost-optimal for non-negative edge costs.
 */
export function runUCS(graph: NavGraph, start: GridCoord, goal: GridCoord): PlannerResult {
  const startTime = performance.now();
  const startK = coordKey(start);
  const goalK = coordKey(goal);

  const pq = new PriorityQueue<GridCoord>();
  pq.push(start, 0);

  const gCost = new Map<string, number>();
  gCost.set(startK, 0);

  const parent = new Map<string, string>();
  const closed = new Set<string>();
  const exploredOrder: GridCoord[] = [];
  let peakFrontier = 1;
  let expandedCount = 0;
  let found = false;

  while (!pq.isEmpty()) {
    peakFrontier = Math.max(peakFrontier, pq.size);
    const curr = pq.pop()!;
    const currK = coordKey(curr);

    if (closed.has(currK)) continue;
    closed.add(currK);
    exploredOrder.push(curr);
    expandedCount++;

    if (currK === goalK) {
      found = true;
      break;
    }

    const currentG = gCost.get(currK) ?? Infinity;

    for (const edge of graph.getNeighbors(curr)) {
      const nextK = coordKey(edge.target);
      const tentativeG = currentG + edge.cost;

      if (tentativeG < (gCost.get(nextK) ?? Infinity)) {
        gCost.set(nextK, tentativeG);
        parent.set(nextK, currK);
        pq.push(edge.target, tentativeG);
      }
    }
  }

  const planningTimeMs = Number((performance.now() - startTime).toFixed(2));
  const path = found ? reconstructPath(parent, startK, goalK) : [];

  return {
    path,
    exploredOrder,
    found,
    metrics: {
      algorithm: 'UCS',
      pathCost: calculatePathCost(path, graph),
      steps: path.length,
      expandedNodes: expandedCount,
      peakFrontier,
      planningTimeMs,
      optimalityNote: 'Guaranteed cost-optimal. Explores uniformly in all directions without heuristic guidance.',
    },
  };
}

/**
 * Greedy Best-First Search
 * Explores exclusively by heuristic distance h(n). Fast but potentially suboptimal.
 */
export function runGreedy(
  graph: NavGraph,
  start: GridCoord,
  goal: GridCoord,
  heuristic: (a: GridCoord, b: GridCoord) => number = octileDistance
): PlannerResult {
  const startTime = performance.now();
  const startK = coordKey(start);
  const goalK = coordKey(goal);

  const pq = new PriorityQueue<GridCoord>();
  pq.push(start, heuristic(start, goal));

  const visited = new Set<string>();
  const parent = new Map<string, string>();
  const exploredOrder: GridCoord[] = [];
  let peakFrontier = 1;
  let expandedCount = 0;
  let found = false;

  while (!pq.isEmpty()) {
    peakFrontier = Math.max(peakFrontier, pq.size);
    const curr = pq.pop()!;
    const currK = coordKey(curr);

    if (visited.has(currK)) continue;
    visited.add(currK);
    exploredOrder.push(curr);
    expandedCount++;

    if (currK === goalK) {
      found = true;
      break;
    }

    for (const edge of graph.getNeighbors(curr)) {
      const nextK = coordKey(edge.target);
      if (!visited.has(nextK)) {
        if (!parent.has(nextK)) {
          parent.set(nextK, currK);
        }
        pq.push(edge.target, heuristic(edge.target, goal));
      }
    }
  }

  const planningTimeMs = Number((performance.now() - startTime).toFixed(2));
  const path = found ? reconstructPath(parent, startK, goalK) : [];

  return {
    path,
    exploredOrder,
    found,
    metrics: {
      algorithm: 'Greedy',
      pathCost: calculatePathCost(path, graph),
      steps: path.length,
      expandedNodes: expandedCount,
      peakFrontier,
      planningTimeMs,
      optimalityNote: 'Suboptimal. Aggressively rushes towards the goal; can be trapped by terrain obstacles.',
    },
  };
}

/**
 * A* Search
 * Priority f(n) = g(n) + h(n).
 * With admissible and consistent heuristic, guaranteed cost-optimal with minimal node expansions.
 */
export function runAStar(
  graph: NavGraph,
  start: GridCoord,
  goal: GridCoord,
  heuristic: (a: GridCoord, b: GridCoord) => number = octileDistance
): PlannerResult {
  const startTime = performance.now();
  const startK = coordKey(start);
  const goalK = coordKey(goal);

  const pq = new PriorityQueue<GridCoord>();
  const gCost = new Map<string, number>();
  gCost.set(startK, 0);

  const startH = heuristic(start, goal);
  pq.push(start, 0 + startH);

  const parent = new Map<string, string>();
  const closed = new Set<string>();
  const exploredOrder: GridCoord[] = [];
  let peakFrontier = 1;
  let expandedCount = 0;
  let found = false;

  while (!pq.isEmpty()) {
    peakFrontier = Math.max(peakFrontier, pq.size);
    const curr = pq.pop()!;
    const currK = coordKey(curr);

    if (closed.has(currK)) continue;
    closed.add(currK);
    exploredOrder.push(curr);
    expandedCount++;

    if (currK === goalK) {
      found = true;
      break;
    }

    const currentG = gCost.get(currK) ?? Infinity;

    for (const edge of graph.getNeighbors(curr)) {
      const nextK = coordKey(edge.target);
      const tentativeG = currentG + edge.cost;

      if (tentativeG < (gCost.get(nextK) ?? Infinity)) {
        gCost.set(nextK, tentativeG);
        parent.set(nextK, currK);
        const f = tentativeG + heuristic(edge.target, goal);
        pq.push(edge.target, f);
      }
    }
  }

  const planningTimeMs = Number((performance.now() - startTime).toFixed(2));
  const path = found ? reconstructPath(parent, startK, goalK) : [];

  return {
    path,
    exploredOrder,
    found,
    metrics: {
      algorithm: 'A*',
      pathCost: calculatePathCost(path, graph),
      steps: path.length,
      expandedNodes: expandedCount,
      peakFrontier,
      planningTimeMs,
      optimalityNote: 'Cost-optimal and maximally efficient with admissible octile distance heuristic.',
    },
  };
}
