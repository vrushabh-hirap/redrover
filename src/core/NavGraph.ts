import { GridCoord, GraphEdge, NavGraph, TerrainData } from '../core/types';

export class GridNavGraph implements NavGraph {
  public readonly width: number;
  public readonly height: number;
  public readonly resolution: number;
  private terrain: TerrainData;

  // 8-direction offsets: orthogonal (dist 1), diagonal (dist sqrt(2))
  private static readonly DIRECTIONS = [
    { dx: 1, dy: 0, dist: 1.0 },
    { dx: -1, dy: 0, dist: 1.0 },
    { dx: 0, dy: 1, dist: 1.0 },
    { dx: 0, dy: -1, dist: 1.0 },
    { dx: 1, dy: 1, dist: Math.SQRT2 },
    { dx: -1, dy: 1, dist: Math.SQRT2 },
    { dx: 1, dy: -1, dist: Math.SQRT2 },
    { dx: -1, dy: -1, dist: Math.SQRT2 },
  ];

  constructor(terrain: TerrainData) {
    this.terrain = terrain;
    this.width = terrain.width;
    this.height = terrain.height;
    this.resolution = terrain.resolution;
  }

  public isWalkable(coord: GridCoord): boolean {
    if (coord.x < 0 || coord.x >= this.width || coord.y < 0 || coord.y >= this.height) {
      return false;
    }
    const cell = this.terrain.cells[coord.y][coord.x];
    return !cell.isHazard;
  }

  public getElevation(coord: GridCoord): number {
    return this.terrain.cells[coord.y][coord.x].elevation;
  }

  public getSlope(coord: GridCoord): number {
    return this.terrain.cells[coord.y][coord.x].slope;
  }

  /**
   * Edge traversal cost between adjacent cells:
   * Non-negative, slope-dependent, with mechanical energy expenditure penalty.
   * cost = dist * (1 + 2.5 * (elev_diff / dist)^2 + roughness_penalty)
   */
  public getCost(from: GridCoord, to: GridCoord): number {
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);
    const dist = (dx === 1 && dy === 1) ? Math.SQRT2 : 1.0;

    const fromCell = this.terrain.cells[from.y][from.x];
    const toCell = this.terrain.cells[to.y][to.x];

    const elevDiff = (toCell.elevation - fromCell.elevation) / this.resolution;
    const slopeFactor = Math.pow(elevDiff / dist, 2);
    const roughnessFactor = (fromCell.roughness + toCell.roughness) * 0.5;

    // Strict non-negative cost; minimum is dist >= 1.0
    return dist * (1.0 + 2.0 * slopeFactor + 0.5 * roughnessFactor);
  }

  /**
   * 8-connected neighbors with strict anti-corner-cutting logic:
   * A diagonal move from (x, y) to (x+dx, y+dy) is disallowed if
   * either orthogonal neighbor (x+dx, y) OR (x, y+dy) is blocked/hazard.
   */
  public getNeighbors(node: GridCoord): GraphEdge[] {
    const neighbors: GraphEdge[] = [];

    for (const dir of GridNavGraph.DIRECTIONS) {
      const nx = node.x + dir.dx;
      const ny = node.y + dir.dy;
      const target: GridCoord = { x: nx, y: ny };

      // Target must be walkable
      if (!this.isWalkable(target)) {
        continue;
      }

      // If diagonal move, check adjacent orthogonal cells (prevent corner-cutting)
      if (dir.dx !== 0 && dir.dy !== 0) {
        const orth1: GridCoord = { x: node.x + dir.dx, y: node.y };
        const orth2: GridCoord = { x: node.x, y: node.y + dir.dy };

        if (!this.isWalkable(orth1) || !this.isWalkable(orth2)) {
          // Corner cutting strictly prohibited
          continue;
        }
      }

      const cost = this.getCost(node, target);
      neighbors.push({ target, cost });
    }

    return neighbors;
  }
}
