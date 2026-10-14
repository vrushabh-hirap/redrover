import { describe, it, expect } from 'vitest';
import { generateSyntheticMarsTerrain } from '../src/data/syntheticTerrain';
import { GridNavGraph } from '../src/core/NavGraph';
import { runBFS, runDFS, runUCS, runGreedy, runAStar } from '../src/planners/searchAlgorithms';
import { octileDistance } from '../src/planners/PriorityQueue';
import { GridCoord } from '../src/core/types';

describe('RedRover Pure Planners Suite', () => {
  const terrain = generateSyntheticMarsTerrain(32, 32, 2.0);
  const graph = new GridNavGraph(terrain);

  const start: GridCoord = { x: 2, y: 2 };
  const goal: GridCoord = { x: 28, y: 28 };

  it('1. A* with h=0 matches UCS exactly in cost and path length', () => {
    const zeroHeuristic = () => 0;
    const ucsResult = runUCS(graph, start, goal);
    const astarZeroH = runAStar(graph, start, goal, zeroHeuristic);

    expect(ucsResult.found).toBe(true);
    expect(astarZeroH.found).toBe(true);
    expect(astarZeroH.metrics.pathCost).toBeCloseTo(ucsResult.metrics.pathCost, 2);
    expect(astarZeroH.metrics.steps).toBe(ucsResult.metrics.steps);
  });

  it('2. BFS matches UCS on a uniform cost graph', () => {
    // Construct a uniform cost wrapper over walkable cells
    const uniformGraph = {
      ...graph,
      getCost: () => 1.0,
      getNeighbors: (node: GridCoord) => {
        return graph.getNeighbors(node).map(edge => ({ target: edge.target, cost: 1.0 }));
      },
    };

    const bfsResult = runBFS(uniformGraph, start, goal);
    const ucsResult = runUCS(uniformGraph, start, goal);

    expect(bfsResult.found).toBe(true);
    expect(ucsResult.found).toBe(true);
    // On uniform 1-cost edges, BFS and UCS find paths with the same number of steps and same cost
    expect(bfsResult.metrics.steps).toBe(ucsResult.metrics.steps);
    expect(bfsResult.metrics.pathCost).toBeCloseTo(ucsResult.metrics.pathCost, 2);
  });

  it('3. A* path cost is <= Greedy path cost (Optimality guarantee)', () => {
    const astarResult = runAStar(graph, start, goal);
    const greedyResult = runGreedy(graph, start, goal);

    expect(astarResult.found).toBe(true);
    expect(greedyResult.found).toBe(true);

    // A* is optimal, so its cost must be less than or equal to Greedy
    expect(astarResult.metrics.pathCost).toBeLessThanOrEqual(greedyResult.metrics.pathCost + 1e-4);
  });

  it('4. Octile distance heuristic is strictly admissible (h(n) <= true remaining cost)', () => {
    // For several sampled nodes, verify h(n) <= true optimal cost computed by UCS
    const sampleNodes: GridCoord[] = [
      { x: 5, y: 5 },
      { x: 10, y: 15 },
      { x: 20, y: 10 },
      { x: 15, y: 25 },
    ];

    for (const node of sampleNodes) {
      if (graph.isWalkable(node)) {
        const hVal = octileDistance(node, goal);
        const trueCost = runUCS(graph, node, goal).metrics.pathCost;

        // Admissibility condition: h(n) <= h*(n)
        expect(hVal).toBeLessThanOrEqual(trueCost + 1e-4);
      }
    }
  });

  it('5. DFS discovers a path and records non-optimal exploration', () => {
    const dfsResult = runDFS(graph, start, goal);
    expect(dfsResult.found).toBe(true);
    expect(dfsResult.path.length).toBeGreaterThan(0);
    expect(dfsResult.metrics.algorithm).toBe('DFS');
  });

  it('6. Strict corner-cutting prohibition works as expected', () => {
    // In GridNavGraph, diagonal move requires both orthogonal cells to be walkable
    const neighbors = graph.getNeighbors({ x: 2, y: 2 });
    for (const n of neighbors) {
      const dx = Math.abs(n.target.x - 2);
      const dy = Math.abs(n.target.y - 2);
      if (dx === 1 && dy === 1) {
        expect(graph.isWalkable({ x: n.target.x, y: 2 })).toBe(true);
        expect(graph.isWalkable({ x: 2, y: n.target.y })).toBe(true);
      }
    }
  });
});
