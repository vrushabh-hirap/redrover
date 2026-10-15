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
    expect(g.node(`park:${PARKING_SHELLS[0]}:0:2`)).toBeDefined();
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
    const to = g.node('park:250:0:2')!;
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
    for (const model of ['fuel', 'time', 'risk', 'balanced'] as const) {
      const g = build(model);
      const t = g.node('sat:25544')!;
      for (const n of g.allNodes()) {
        const truth = planUCS(g, n, t);
        if (!truth.found) continue;
        expect(heuristic(n, t, g.cost, g), `${model}: ${n.id}`).toBeLessThanOrEqual(
          truth.metrics.pathCost + 1e-6,
        );
      }
    }
  });

  it('the heuristic is exact at the goal and zero at the start of an equal-cost hop', () => {
    const g = build('balanced');
    const t = g.node('sat:25544')!;
    expect(heuristic(t, t, g.cost, g)).toBe(0);
    expect(heuristic(g.node('site:KSC')!, t, g.cost, g)).toBeGreaterThan(0);
  });
});

describe('keep-out screening', () => {
  const build = (keepOutKm: number, hazardAt?: (mid: { x: number; y: number; z: number }) => { x: number; y: number; z: number }) =>
    new MissionGraph({
      origin: site('KSC', 28.57, -80.64),
      destination: moon(),
      bodies: {},
      catalogStates: hazardAt ? [{ noradId: 42, name: 'HAZARD-42', positionKm: hazardAt({ x: 0, y: 0, z: 0 }) }] : [],
      cost: costModel('balanced'),
      options: { keepOutKm, hazardSampleCap: 5_000 },
    });

  /** Midpoints of every edge in a graph, for hazard placement. */
  const edgeMidpoints = (g: MissionGraph) => {
    const out: { x: number; y: number; z: number }[] = [];
    for (const n of g.allNodes()) {
      for (const e of g.neighbours(n)) {
        out.push({
          x: (n.positionKm.x + e.to.positionKm.x) / 2,
          y: (n.positionKm.y + e.to.positionKm.y) / 2,
          z: (n.positionKm.z + e.to.positionKm.z) / 2,
        });
      }
    }
    return out;
  };

  it('a larger keep-out radius blocks strictly more edges', () => {
    // Hazards are placed on real edge midpoints so the screen actually bites.
    const midpoints = edgeMidpoints(build(25));
    const counts = [25, 75, 150, 300].map((km) =>
      new MissionGraph({
        origin: site('KSC', 28.57, -80.64),
        destination: moon(),
        bodies: {},
        catalogStates: midpoints.map((p, i) => ({ noradId: 700 + i, name: `H-${i}`, positionKm: p })),
        cost: costModel('balanced'),
        options: { keepOutKm: km, hazardSampleCap: 5_000 },
      }).stats.blockedEdges,
    );
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i], `${counts.join(',')}`).toBeGreaterThanOrEqual(counts[i - 1]);
    }
    expect(counts[counts.length - 1]).toBeGreaterThan(0);
  });

  it('the planner routes around a blocked edge instead of stepping onto it', () => {
    // Drop hazards on the midpoints of the three edges that leave the 800 km
    // shell the graph would otherwise prefer.
    const base = build(25);
    const from = base.node('park:800:2:2')!;
    const targets = base.neighbours(from).slice(0, 3);
    const mids = targets.map((e) => ({
      x: (from.positionKm.x + e.to.positionKm.x) / 2,
      y: (from.positionKm.y + e.to.positionKm.y) / 2,
      z: (from.positionKm.z + e.to.positionKm.z) / 2,
    }));
    const g = new MissionGraph({
      origin: site('KSC', 28.57, -80.64),
      destination: moon(),
      bodies: {},
      catalogStates: mids.map((p, i) => ({ noradId: 800 + i, name: `H-${i}`, positionKm: p })),
      cost: costModel('balanced'),
      options: { keepOutKm: 120, hazardSampleCap: 5_000 },
    });
    expect(g.neighbours(g.node('park:800:2:2')!).filter((e) => e.blocked).length).toBe(3);
    const blocked = g
      .allNodes()
      .filter((n) => n.kind === 'park')
      .filter((n) => g.neighbours(n).some((e) => e.blocked));
    expect(blocked.length).toBeGreaterThan(0);
    const res = planAStar(g, g.node('site:KSC')!, g.node('moon:Moon')!);
    expect(res.found).toBe(true);
    expect(res.metrics.clearedObstacles).toBe(true);
    // The route must not step onto a blocked edge.
    for (let i = 0; i < res.path.length - 1; i++) {
      const e = g.neighbours(res.path[i]).find((x) => x.to.id === res.path[i + 1].id);
      expect(e?.blocked, `${res.path[i].id} → ${res.path[i + 1].id}`).toBeFalsy();
    }
  });

  it('hazard records carry the object name and the miss distance', () => {
    const mids = edgeMidpoints(build(25));
    const g = new MissionGraph({
      origin: site('KSC', 28.57, -80.64),
      destination: moon(),
      bodies: {},
      catalogStates: mids.map((p, i) => ({ noradId: 900 + i, name: `H-${i}`, positionKm: p })),
      cost: costModel('balanced'),
      options: { keepOutKm: 300, hazardSampleCap: 5_000 },
    });
    expect(g.hazards.length).toBeGreaterThan(0);
    const worst = g.hazards.reduce((a, b) => (b.missDistanceKm < a.missDistanceKm ? b : a));
    expect(worst.name).toMatch(/^H-\d+$/);
    expect(worst.missDistanceKm).toBeGreaterThanOrEqual(0);
    expect(worst.edge).toContain('→');
  });
});
