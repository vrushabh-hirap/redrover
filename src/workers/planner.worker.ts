import { GridCoord, TerrainData, PlannerResult } from '../core/types';
import { GridNavGraph } from '../core/NavGraph';
import { runBFS, runDFS, runUCS, runGreedy, runAStar, PlannerType } from '../planners/searchAlgorithms';

export interface PlannerWorkerRequest {
  algorithm: PlannerType;
  terrain: TerrainData;
  start: GridCoord;
  goal: GridCoord;
}

export interface PlannerWorkerResponse {
  algorithm: PlannerType;
  result: PlannerResult;
  error?: string;
}

self.onmessage = (e: MessageEvent<PlannerWorkerRequest>) => {
  const { algorithm, terrain, start, goal } = e.data;
  try {
    const graph = new GridNavGraph(terrain);
    let result: PlannerResult;

    switch (algorithm) {
      case 'bfs':
        result = runBFS(graph, start, goal);
        break;
      case 'dfs':
        result = runDFS(graph, start, goal);
        break;
      case 'ucs':
        result = runUCS(graph, start, goal);
        break;
      case 'greedy':
        result = runGreedy(graph, start, goal);
        break;
      case 'astar':
      default:
        result = runAStar(graph, start, goal);
        break;
    }

    const response: PlannerWorkerResponse = {
      algorithm,
      result,
    };
    self.postMessage(response);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    self.postMessage({
      algorithm,
      result: {
        path: [],
        exploredOrder: [],
        found: false,
        metrics: {
          algorithm,
          pathCost: 0,
          steps: 0,
          expandedNodes: 0,
          peakFrontier: 0,
          planningTimeMs: 0,
          optimalityNote: `Worker error: ${errorMsg}`,
        },
      },
      error: errorMsg,
    });
  }
};
