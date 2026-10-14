export interface GridCoord {
  x: number;
  y: number;
}

export interface TerrainCell {
  x: number;
  y: number;
  elevation: number; // in meters
  slope: number;     // in degrees (0 - 90)
  roughness: number; // 0 to 1
  isHazard: boolean;
  hazardType?: 'crater_rim' | 'boulder' | 'steep_slope' | 'sand_trap';
}

export interface TerrainData {
  width: number;
  height: number;
  resolution: number; // meters per grid cell (e.g., 2.0m)
  cells: TerrainCell[][];
  minElevation: number;
  maxElevation: number;
  provenance: {
    source: 'SYNTHETIC_FALLBACK';
    label: string;
    description: string;
  };
}

export interface GraphEdge {
  target: GridCoord;
  cost: number;
}

export interface NavGraph {
  width: number;
  height: number;
  resolution: number;
  getNeighbors(node: GridCoord): GraphEdge[];
  isWalkable(coord: GridCoord): boolean;
  getCost(from: GridCoord, to: GridCoord): number;
  getElevation(coord: GridCoord): number;
  getSlope(coord: GridCoord): number;
}

export interface PlannerMetrics {
  algorithm: string;
  pathCost: number;
  steps: number;
  expandedNodes: number;
  peakFrontier: number;
  planningTimeMs: number;
  optimalityNote: string;
}

export interface PlannerResult {
  path: GridCoord[];
  exploredOrder: GridCoord[];
  metrics: PlannerMetrics;
  found: boolean;
}
