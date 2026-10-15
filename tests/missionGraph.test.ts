import { describe, it, expect } from 'vitest';
import {
  MissionGraph,
  MissionNode,
  costModel,
  heuristic,
  sitePositionKm,
  PARKING_SHELLS,
} from '../src/core/missionGraph';
import {
  ALGORITHMS,
  ALGORITHM_ORDER,
  runAllStatic,
  planAStar,
  planUCS,
  planGreedy,
  planBFS,
  planDFS,
} from '../src/planners/staticPlanners';

const site = (name: string, lat: number, lon: number): MissionNode => ({
  id: `site:${name}`,
  name,
  kind: 'site',
  positionKm: sitePositionKm(lat, lon),
});

const moon = (): MissionNode => ({
  id: 'moon:Moon',
  name: 'Moon',
  kind: 'moon',
  positionKm: { x: 384_400, y: 0, z: 0 },
});

const sat = (noradId: number, name: string, alt: number): MissionNode => ({
  id: `sat:${noradId}`,
  name,
  kind: 'sat',
  noradId,
  altitudeKm: alt,
  positionKm: sitePositionKm(28.5, -80.6, alt),
});

function toyStates(count = 40) {
  const out: { noradId: number; name: string; positionKm: { x: number; y: number; z: number } }[] = [];
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2;
    const r = 6378 + 500;
    out.push({
      noradId: 90000 + i,
      name: `TOY-${i}`,
      positionKm: { x: r * Math.cos(ang), y: r * Math.sin(ang) * 0.2, z: r * Math.sin(ang) },
    });
  }
  return out;
}

describe('mission navigation graph', () => {
  it('exposes parking shells and connects a surface site to them', () => {
    const g = new MissionGraph({
      origin: site('KSC', 28.57, -80.64),
      destination: moon(),
      bodies: {},
      catalogStates: [],
      cost: costModel('balanced'),
    });
    expect(g.node(`park:${PARKING_SHELLS[0]}:0`)).toBeDefined();
    expect(g.neighbours(g.node('site:KSC')!).length).toBeGreaterThan(0);
    expect(g.stats.nodes).toBeGreaterThan(60);
    expect(g.stats.edges).toBeGreaterThan(100);
    expect(g.version).toContain('cost=balanced');
  });

  it('produces identical graph versions for identical inputs', () => {
    const mk = () =>
      new MissionGraph({
        origin: site('KSC', 28.57, -80.64),
        destination: moon(),
        bodies: {},
        catalogStates: toyStates(10),
        cost: costModel('balanced'),
      });
    // The serial differs by design (each build is a distinct object); the
    // semantic part of the version must match.
    const a = mk().version.replace(/graph#\d+/, '');
    const b = mk().version.replace(/graph#\d+/, '');
    expect(a).toBe(b);
  });

  it('cost models actually change the objective', () => {
    const fuel = new MissionGraph({
      origin: site('KSC', 28.57, -80.64),
      destination: sat(25544, 'ISS', 420),
      bodies: {},
      catalogStates: [],
      cost: costModel('fuel'),
    });
    const time = new MissionGraph({
      origin: site('KSC', 28.57, -80.64),
      destination: sat(25544, 'ISS', 420),
      bodies: {},
      catalogStates: [],
      cost: costModel('time'),
    });
    const e = fuel.neighbours(fuel.node('site:KSC')!)[0];
    const e2 = time.neighbours(time.node('site:KSC')!)[0];
    expect(fuel.edgeCost(e)).toBeCloseTo(e.deltaVMs, 5);
    expect(time.edgeCost(e2)).toBeCloseTo(e2.durationSec, 5);
  });

  it('blocks edges that pass inside the keep-out sphere', () => {
    // Place a hazard exactly on the midpoint of one site → shell edge.
    const g = new MissionGraph({
      origin: site('KSC', 28.57, -80.64),
      destination: moon(),
      bodies: {},
      catalogStates: [],
      cost: costModel('balanced'),
    });
    const from = g.node('site:KSC')!;
    const to = g.node('park:250:0')!;
    const mid = {
      x: (from.positionKm.x + to.positionKm.x) / 2,
      y: (from.positionKm.y + to.positionKm.y) / 2,
      z: (from.positionKm.z + to.positionKm.z) / 2,
    };
    const g2 = new MissionGraph({
      origin: from,
      destination: g.node('moon:Moon')!,
      bodies: {},
      catalogStates: [{ noradId: 1, name: 'HAZARD', positionKm: mid }],
      cost: costModel('balanced'),
      options: { keepOutKm: 25 },
    });
    const edges = g2.neighbours(from);
    expect(edges.some((e) => e.blocked)).toBe(true);
    expect(g2.hazards.length).toBeGreaterThan(0);
  });
});

describe('static search algorithms over the mission graph', () => {
  const build = (costId: Parameters<typeof costModel>[0] = 'balanced') =>
    new MissionGraph({
      origin: site('KSC', 28.57, -80.64),
      destination: sat(25544, 'ISS', 420),
      bodies: {},
      catalogStates: toyStates(),
      cost: costModel(costId),
    });

  it('all five algorithms find a route on the same graph', () => {
    const g = build();
    const results = runAllStatic(g, g.node('site:KSC')!, g.node('sat:25544')!);
    expect(results.map((r) => r.algorithm)).toEqual(ALGORITHM_ORDER);
    for (const r of results) {
      expect(r.found, `${r.algorithm} should find a route`).toBe(true);
      expect(r.path.length).toBeGreaterThan(1);
      expect(r.metrics.expandedNodes).toBeGreaterThan(0);
      expect(Number.isFinite(r.metrics.pathCost)).toBe(true);
    }
  });

  it('UCS is never more expensive than BFS/DFS/Greedy', () => {
    const g = build('fuel');
    const s = g.node('site:KSC')!;
    const t = g.node('sat:25544')!;
    const ucs = planUCS(g, s, t);
    for (const r of [planBFS(g, s, t), planDFS(g, s, t), planGreedy(g, s, t)]) {
      expect(ucs.metrics.pathCost).toBeLessThanOrEqual(r.metrics.pathCost + 1e-6);
    }
  });

  it('A* with an admissible heuristic matches UCS cost and expands no more nodes', () => {
    const g = build('balanced');
    const s = g.node('site:KSC')!;
    const t = g.node('sat:25544')!;
    const ucs = planUCS(g, s, t);
    const astar = planAStar(g, s, t);
    expect(astar.metrics.pathCost).toBeCloseTo(ucs.metrics.pathCost, 6);
    expect(astar.metrics.expandedNodes).toBeLessThanOrEqual(ucs.metrics.expandedNodes);
  });

  it('the five algorithms are genuinely different implementations', () => {
    const g = build();
    const s = g.node('site:KSC')!;
    const t = g.node('sat:25544')!;
    const results = runAllStatic(g, s, t);
    const shapes = results.map((r) => `${r.metrics.expandedNodes}:${r.metrics.pathCost.toFixed(3)}`);
    // At least three distinct (expanded, cost) fingerprints must appear.
    expect(new Set(shapes).size).toBeGreaterThanOrEqual(3);
  });

  it('returns an explainable, non-crashing result for an unreachable goal', () => {
    const g = build();
    // A destination that shares no adjacency with the shells.
    const island: MissionNode = { id: 'moon:Europa', name: 'Europa', kind: 'moon', positionKm: { x: 1, y: 2, z: 3 } };
    g.nodes.set(island.id, island);
    const r = planAStar(g, g.node('site:KSC')!, island);
    expect(r.found).toBe(false);
    expect(r.path).toHaveLength(0);
    expect(r.metrics.pathCost).toBe(Infinity);
    expect(r.metrics.optimality).toBe(ALGORITHMS.astar.optimality);
    expect(r.metrics.algorithm).toBe('A*');
  });

  it('the heuristic never exceeds the true remaining cost (admissibility)', () => {
    const g = build('balanced');
    const s = g.node('site:KSC')!;
    const t = g.node('sat:25544')!;
    const truth = planUCS(g, s, t).metrics.pathCost;
    expect(heuristic(s, t, g.cost)).toBeLessThanOrEqual(truth + 1e-6);
  });
});
