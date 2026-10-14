# RedRover Architecture & Assumptions

## Initial Stack & Decisions (Phase 0 & 1)
- **Framework & Language**: TypeScript 5+ with Vite + React 19.
- **3D Visualization**: Three.js standard rendering engine with custom Orbit/Pan/Zoom camera controls, optimized heightfield mesh, and dynamic rover model.
- **Planners (Pure TypeScript Modules)**:
  - BFS (Breadth-First Search)
  - DFS (Depth-First Search)
  - UCS (Uniform Cost Search / Dijkstra)
  - Greedy Best-First Search
  - A* Search
  - Designed for execution in Web Workers without any DOM/Canvas dependencies.
- **Testing Engine**: Vitest for pure algorithm verification.

## Data Provenance & Synthetic Fallback
- No NASA DTM files processed yet in Phase 1.
- Terrain is generated synthetically using crater and slope procedural functions, clearly marked with the **"SYNTHETIC FALLBACK – NOT NASA DATA"** provenance badge.
- Hazards, battery levels, solar insolation, and path costs are simulated based on physical terrain slope and roughness models.

## Navigation Graph Rules
- **Grid Topology**: 8-connected grid.
- **Diagonal Movement & Corner-Cutting Prevention**: Diagonal transitions between $(x_1, y_1)$ and $(x_2, y_2)$ are forbidden if either orthogonal neighboring cell is impassable/blocked.
- **Cost Formulation**:
  - Distance: $\Delta d = 1$ for orthogonal, $\sqrt{2} \approx 1.4142$ for diagonal.
  - Slope angle: $\theta = \arctan(|\Delta z| / \Delta d)$.
  - Impassable slope threshold: $> 25^\circ$ is impassable for the rover chassis.
  - Traverse cost: $\text{cost} = \Delta d \cdot (1.0 + \kappa \cdot \tan^2(\theta) + \text{hazard\_penalty})$.
  - Costs are strictly non-negative ($\ge \Delta d > 0$).
- **A* Heuristic**:
  - Octile distance scaled by minimum possible edge cost ($\min \text{cost} = 1.0$), ensuring admissibility ($h(n) \le h^*(n)$) and consistency.
