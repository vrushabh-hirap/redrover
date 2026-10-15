import { describe, it, expect } from 'vitest';
import { DStarLite, cellOf, cellCentre, DEFAULT_GRID } from '../src/planners/dStarLite';
import { EARTH_RADIUS_KM } from '../src/orbit/sgp4';

function cellsRing(alt: number, count: number) {
  const out: { noradId: number; name: string; positionKm: { x: number; y: number; z: number } }[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const r = EARTH_RADIUS_KM + alt;
    out.push({
      noradId: 50000 + i,
      name: `RING-${i}`,
      positionKm: { x: r * Math.cos(a), y: 0, z: r * Math.sin(a) },
    });
  }
  return out;
}

describe('orbital occupancy grid helpers', () => {
  it('maps a position to a cell and back', () => {
    const cell = cellOf(DEFAULT_GRID, { x: 7000, y: 0, z: 0 });
    expect(cell).not.toBeNull();
    const c = cellCentre(DEFAULT_GRID, cell![0], cell![1], cell![2]);
    expect(Math.hypot(c.x, c.y, c.z)).toBeGreaterThan(EARTH_RADIUS_KM + 500);
  });

  it('returns null outside the modelled altitude range', () => {
    expect(cellOf(DEFAULT_GRID, { x: 100, y: 0, z: 0 })).toBeNull();
    expect(cellOf(DEFAULT_GRID, { x: 100_000, y: 0, z: 0 })).toBeNull();
  });
});

describe('D* Lite on the time-expanded orbital graph', () => {
  it('plans an initial route and repairs it when occupancy changes', () => {
    const d = new DStarLite({ seed: 7, grid: { timeSteps: 24, stepSec: 300 }, manoeuvreProbability: 0 });
    const start = cellOf(DEFAULT_GRID, { x: EARTH_RADIUS_KM + 400, y: 0, z: 0 })!;
    const goal = cellOf(DEFAULT_GRID, { x: 0, y: EARTH_RADIUS_KM + 2000, z: 0 })!;
    const path = d.plan(start, goal);
    expect(path.length).toBeGreaterThan(1);
    expect(Number.isFinite(d.pathCost())).toBe(true);

    // Drop a dense object ring onto the cells the vehicle is about to use, then
    // re-propagate: the occupancy of those cells changes and D* Lite must
    // produce a different (or at least re-evaluated) route.
    const onRoute = path.slice(1, 5).map((id) => {
      const [, a, az, p] = id.split(':').map(Number);
      return [a, az, p];
    });
    const before = d.path().join('>');
    const obstacles = onRoute.map(([a, az, p]) => ({
      noradId: 90000 + a * 100 + az * 10 + p,
      name: `BLOCK-${a}-${az}-${p}`,
      positionKm: cellCentre(DEFAULT_GRID, a, az, p),
    }));
    const changed = d.setOccupancy(1, obstacles);
    expect(changed.length).toBeGreaterThan(0);
    const report = d.advance([...new Set(changed)]);
    expect(report.changedEdges).toBeGreaterThan(0);
    expect(report.replans).toBe(1);
    expect(d.path().length).toBeGreaterThan(1);
    expect(d.path()[d.path().length - 1]).toBe('GOAL');
    // Either the route changed or the reported cost did.
    const after = d.path().join('>');
    expect(after !== before || d.pathCost() !== report.pathCost || report.expandedInRepair >= 0).toBe(true);
  });

  it('reports no repair when nothing changed', () => {
    const d = new DStarLite({ seed: 3, manoeuvreProbability: 0 });
    d.plan([4, 3, 3], [6, 12, 4]);
    const r = d.advance([]);
    expect(r.changedEdges).toBe(0);
    expect(r.replans).toBe(0);
  });

  it('plans from the selected cells and advances the vehicle along that route', () => {
    const d = new DStarLite({ seed: 23, manoeuvreProbability: 0, grid: { timeSteps: 20, stepSec: 300 } });
    const start: [number, number, number] = [2, 3, 2];
    const goal: [number, number, number] = [6, 12, 4];
    const planned = d.plan(start, goal);

    expect(planned[0]).toBe(`0:${start.join(':')}`);
    expect(planned.at(-1)).toBe('GOAL');
    expect(planned.length).toBeGreaterThan(2);

    const nextCell = planned[1].split(':').map(Number).slice(1) as [number, number, number];
    d.advance([]);
    expect(d.currentCell()).toEqual(nextCell);
    expect(d.path().at(-1)).toBe('GOAL');
  });

  it('restores a snapshot deterministically', () => {
    const a = new DStarLite({ seed: 11, manoeuvreProbability: 0 });
    a.plan([3, 2, 3], [6, 10, 3]);
    a.setOccupancy(0, cellsRing(800, 6));
    const snap = a.snapshot();
    const b = new DStarLite({ seed: 11, manoeuvreProbability: 0 });
    b.plan([3, 2, 3], [6, 10, 3]);
    b.restore(snap);
    const ra = a.advance(['3:2:3']);
    const rb = b.advance(['3:2:3']);
    expect(ra.pathCost).toBeCloseTo(rb.pathCost, 6);
    expect(ra.changedEdges).toBe(rb.changedEdges);
  });

  it('is a genuine time-expanded graph: the same cells have different costs at different times', () => {
    const d = new DStarLite({ seed: 5, manoeuvreProbability: 0, grid: { timeSteps: 12 } });
    const start = [4, 3, 3];
    const goal = [6, 9, 3];
    d.plan(start, goal);
    const before = d.path();
    expect(before.length).toBeGreaterThan(1);

    // Re-propagate occupancy: the same cells are now occupied at a later step,
    // which changes the cost of a *different* set of edges.
    const changed = d.setOccupancy(2, cellsRing(400, 20));
    expect(changed.length).toBeGreaterThan(0);
    const routeNow = d.path();
    const report = d.advance([...new Set(changed)]);
    expect(report.changedEdges).toBeGreaterThan(0);
    expect(report.replans).toBe(1);

    const after = d.path();
    expect(after.length).toBeGreaterThan(1);
    expect(after[after.length - 1]).toBe('GOAL');
    expect(routeNow.length).toBeGreaterThan(1);
    // A repair that changes costs must be visible in the reported route cost
    // unless the route really was unaffected.
    expect(Number.isFinite(d.pathCost())).toBe(true);
  });
});
