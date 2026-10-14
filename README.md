# RedRover: Interactive 3D Educational Mars Rover AI Mission Simulator

**RedRover** is an interactive, browser-based 3D Mars rover AI mission simulator designed to visualize, benchmark, and educate users on robotics path planning and decision-making on Martian terrain.

---

## 1. Stack & System Architecture

- **Core & Framework**: TypeScript 5+, React 19, Vite.
- **3D Graphics**: Three.js WebGL rendering engine with custom shaders, procedural heightfield mesh, and dynamic rocker-bogie Mars rover model.
- **Path Planners (Pure Modules)**:
  - **A\*** (Optimal with admissible octile distance heuristic)
  - **UCS** (Uniform Cost Search / Dijkstra)
  - **Greedy Best-First Search**
  - **BFS** (Breadth-First Search)
  - **DFS** (Depth-First Search)
  - *All planners run on pure data structures with zero DOM/Three.js dependencies for unit testing and Web Worker offloading.*
- **Data Provenance**:
  - Phase 1 uses a procedural analogue terrain clearly tagged with the visible provenance badge:  
    `SYNTHETIC FALLBACK – NOT NASA DATA`.
  - Hazards, battery levels, insolation, and step costs are simulated.

---

## 2. Setup & Run Commands

### Prerequisites
- Node.js (v18+ or v22+)
- npm or pnpm

### Installation
```bash
npm install
```

### Run Unit Tests
```bash
npx vitest run
```

### Launch Development Server
```bash
npm run dev
```
Visit `http://localhost:5173/` in your browser.

### Production Build
```bash
npm run build
```

---

## 3. Verified Phase 1 Capabilities

1. **Pure Search Planners & Benchmarking**:
   - Comprehensive test suite in [`tests/planners.test.ts`](file:///Users/vrushabhhirap/Desktop/Codes/Projects/RedRover/tests/planners.test.ts) passing 100% of assertions:
     - $A^*$ with $h=0$ matches UCS identically.
     - BFS matches UCS on uniform cost graphs.
     - $A^*$ path cost $\le$ Greedy path cost (optimality verification).
     - Octile distance heuristic is strictly admissible ($h(n) \le h^*(n)$).
     - Strict anti-corner-cutting prevents clipping blocked diagonal cells.
2. **3D Interactive Scene**:
   - Custom textured Martian terrain with craters, ejecta rims, and sand traps.
   - Detailed Mars rover with chassis, solar arrays, mast camera, and rocker-bogie wheels.
   - Left-drag Orbit, Right-drag Pan, Mousewheel Zoom, and 1-click Camera Reset.
   - Heading alignment and pitch slope adaptation.
3. **Mission Control Dashboard & 2D Minimap**:
   - Real-time telemetry: Grid coordinates, battery percentage, elevation, slope, heading, and pitch.
   - Algorithm switcher and metrics comparison (time, path cost, expanded nodes, peak frontier).
   - Autopilot traverse, single-step execution, and landing site reset.
   - Interactive 2D minimap with target repositioning.
