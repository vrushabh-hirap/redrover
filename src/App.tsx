import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { generateSyntheticMarsTerrain } from './data/syntheticTerrain';
import { GridNavGraph } from './core/NavGraph';
import { TerrainScene } from './rendering/TerrainScene';
import { Minimap } from './ui/minimap/Minimap';
import { Dashboard } from './ui/components/Dashboard';
import { ProvenanceBadge } from './ui/components/ProvenanceBadge';
import { GridCoord, PlannerResult, TerrainData } from './core/types';
import { PlannerType, runAStar, runBFS, runDFS, runUCS, runGreedy } from './planners/searchAlgorithms';
import { Compass, Sparkles } from 'lucide-react';
import confetti from 'canvas-confetti';

export const App: React.FC = () => {
  // 1. Terrain state (64x64 synthetic terrain analogue)
  const [terrain] = useState<TerrainData>(() => generateSyntheticMarsTerrain(64, 64, 2.0));
  const navGraph = useMemo(() => new GridNavGraph(terrain), [terrain]);

  // 2. Mission Waypoints
  const [start, setStart] = useState<GridCoord>({ x: 4, y: 4 });
  const [goal, setGoal] = useState<GridCoord>({ x: 58, y: 56 });
  const [roverPos, setRoverPos] = useState<GridCoord>(start);
  const [pathIndex, setPathIndex] = useState<number>(0);

  // 3. Planning state
  const [selectedAlgorithm, setSelectedAlgorithm] = useState<PlannerType>('astar');
  const [plannerResult, setPlannerResult] = useState<PlannerResult | null>(null);
  const [isCalculating, setIsCalculating] = useState<boolean>(false);

  // 4. Telemetry state
  const [battery, setBattery] = useState<number>(100.0);
  const [headingDeg, setHeadingDeg] = useState<number>(0);
  const [pitchDeg, setPitchDeg] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [decisionLogs, setDecisionLogs] = useState<string[]>([
    '[INIT] RedRover Core System Online.',
    '[TELEMETRY] Subsystems nominal. Solar insolation active.',
  ]);

  // Three.js Canvas Container Ref
  const sceneContainerRef = useRef<HTMLDivElement | null>(null);
  const sceneInstanceRef = useRef<TerrainScene | null>(null);

  // Add Log Entry
  const addLog = useCallback((msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setDecisionLogs((prev) => [...prev, `[${timestamp}] ${msg}`]);
  }, []);

  // Compute Path Plan
  const planMissionPath = useCallback((alg: PlannerType, startNode: GridCoord, goalNode: GridCoord) => {
    setIsCalculating(true);
    addLog(`Running ${alg.toUpperCase()} path planner...`);

    // Pure planner execution
    let res: PlannerResult;
    switch (alg) {
      case 'bfs':
        res = runBFS(navGraph, startNode, goalNode);
        break;
      case 'dfs':
        res = runDFS(navGraph, startNode, goalNode);
        break;
      case 'ucs':
        res = runUCS(navGraph, startNode, goalNode);
        break;
      case 'greedy':
        res = runGreedy(navGraph, startNode, goalNode);
        break;
      case 'astar':
      default:
        res = runAStar(navGraph, startNode, goalNode);
        break;
    }

    setPlannerResult(res);
    setIsCalculating(false);

    if (res.found) {
      addLog(`SUCCESS: Route calculated (${res.path.length} waypoints, cost ${res.metrics.pathCost.toFixed(2)}).`);
    } else {
      addLog(`ERR: No traversable corridor to target (${goalNode.x}, ${goalNode.y}).`);
    }

    // Update 3D scene visual overlays
    if (sceneInstanceRef.current) {
      sceneInstanceRef.current.drawPath(res.path);
      sceneInstanceRef.current.drawExploredNodes(res.exploredOrder);
      sceneInstanceRef.current.setStartAndGoalMarkers(startNode, goalNode);
    }
  }, [navGraph, addLog]);

  // Initialize Three.js scene
  useEffect(() => {
    if (!sceneContainerRef.current) return;
    const scene = new TerrainScene(sceneContainerRef.current, terrain);
    sceneInstanceRef.current = scene;

    scene.setStartAndGoalMarkers(start, goal);
    const startWorld = scene.gridToWorld(start.x, start.y);
    scene.updateRoverPose(startWorld, 0, 0, 0);

    // Initial plan
    planMissionPath(selectedAlgorithm, start, goal);

    return () => {
      scene.dispose();
      sceneInstanceRef.current = null;
    };
  }, []);

  // Re-plan when algorithm or goal changes
  useEffect(() => {
    if (sceneInstanceRef.current) {
      planMissionPath(selectedAlgorithm, roverPos, goal);
    }
  }, [selectedAlgorithm, goal]);

  // Step movement logic
  const stepRover = useCallback(() => {
    if (!plannerResult || !plannerResult.found || plannerResult.path.length === 0) return;

    if (pathIndex >= plannerResult.path.length - 1) {
      setIsPlaying(false);
      addLog('MISSION COMPLETE: Target location reached successfully!');
      confetti({ particleCount: 70, spread: 60, origin: { y: 0.8 } });
      return;
    }

    const nextIdx = pathIndex + 1;
    const nextNode = plannerResult.path[nextIdx];
    const prevNode = plannerResult.path[pathIndex];

    // Compute heading and pitch
    const dx = nextNode.x - prevNode.x;
    const dy = nextNode.y - prevNode.y;
    const headingAngleRad = Math.atan2(dx, dy);
    const headingAngleDeg = (headingAngleRad * 180) / Math.PI;

    const fromCell = terrain.cells[prevNode.y][prevNode.x];
    const toCell = terrain.cells[nextNode.y][nextNode.x];
    const stepCost = navGraph.getCost(prevNode, nextNode);
    const elevDelta = toCell.elevation - fromCell.elevation;
    const pitchAngleRad = Math.atan2(-elevDelta, 2.0); // pitch up/down
    const pitchAngleDeg = (pitchAngleRad * 180) / Math.PI;

    // Update rover position in 3D Scene
    if (sceneInstanceRef.current) {
      const worldPos = sceneInstanceRef.current.gridToWorld(nextNode.x, nextNode.y);
      sceneInstanceRef.current.updateRoverPose(worldPos, headingAngleRad, pitchAngleRad, 0);
    }

    setRoverPos(nextNode);
    setPathIndex(nextIdx);
    setHeadingDeg(headingAngleDeg >= 0 ? headingAngleDeg : 360 + headingAngleDeg);
    setPitchDeg(pitchAngleDeg);

    // Simulated battery drain based on slope and roughness
    setBattery((prev) => Math.max(0, prev - (0.15 + (toCell.slope / 20) * 0.4)));

    addLog(`Traverse to (${nextNode.x}, ${nextNode.y}) | Step Cost: ${stepCost.toFixed(2)} | Slope: ${toCell.slope}°`);
  }, [plannerResult, pathIndex, terrain, navGraph, addLog]);

  // Autopilot interval timer
  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => {
      stepRover();
    }, 280);

    return () => clearInterval(interval);
  }, [isPlaying, stepRover]);

  const handleReset = () => {
    setIsPlaying(false);
    setPathIndex(0);
    setRoverPos(start);
    setBattery(100.0);
    if (sceneInstanceRef.current) {
      const worldPos = sceneInstanceRef.current.gridToWorld(start.x, start.y);
      sceneInstanceRef.current.updateRoverPose(worldPos, 0, 0, 0);
    }
    planMissionPath(selectedAlgorithm, start, goal);
    addLog('[RESET] Rover returned to landing site.');
  };

  const handleSelectGoal = (newGoal: GridCoord) => {
    if (!navGraph.isWalkable(newGoal)) {
      addLog(`ERR: Target (${newGoal.x}, ${newGoal.y}) is situated on hazardous terrain.`);
      return;
    }
    setGoal(newGoal);
    setPathIndex(0);
    addLog(`Target waypoint updated to (${newGoal.x}, ${newGoal.y}). Recomputing corridor...`);
  };

  const currentCell = terrain.cells[roverPos.y]?.[roverPos.x] ?? { elevation: 0, slope: 0 };

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden', background: '#0c0709' }}>
      {/* 3D WebGL Canvas Viewport */}
      <div ref={sceneContainerRef} style={{ width: '100%', height: '100%' }} />

      {/* Top Header & Provenance Banner */}
      <header
        style={{
          position: 'absolute',
          top: 16,
          left: 20,
          right: 20,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            background: 'rgba(23, 14, 18, 0.8)',
            padding: '8px 18px',
            borderRadius: '12px',
            backdropFilter: 'blur(12px)',
            border: '1px solid rgba(244, 63, 94, 0.25)',
          }}
        >
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ef4444', boxShadow: '0 0 10px #ef4444' }} />
          <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 800, letterSpacing: '0.04em', color: '#ffffff' }}>
            RedRover
          </h1>
          <span style={{ fontSize: '11px', color: '#94a3b8', borderLeft: '1px solid rgba(255,255,255,0.15)', paddingLeft: '10px' }}>
            Interactive 3D Mars Mission Simulator • Phase 1
          </span>
        </div>

        <div style={{ pointerEvents: 'auto' }}>
          <ProvenanceBadge
            label={terrain.provenance.label}
            source={terrain.provenance.source}
            description={terrain.provenance.description}
          />
        </div>
      </header>

      {/* Left Mission Dashboard Overlay */}
      <div style={{ position: 'absolute', top: 80, left: 20, zIndex: 10 }}>
        <Dashboard
          algorithm={selectedAlgorithm}
          onSelectAlgorithm={(alg) => setSelectedAlgorithm(alg)}
          isPlaying={isPlaying}
          onTogglePlay={() => setIsPlaying(!isPlaying)}
          onStep={stepRover}
          onReset={handleReset}
          onResetCamera={() => sceneInstanceRef.current?.resetCamera()}
          roverPos={roverPos}
          headingDeg={headingDeg}
          pitchDeg={pitchDeg}
          battery={battery}
          currentElevation={currentCell.elevation}
          currentSlope={currentCell.slope}
          metrics={plannerResult?.metrics ?? null}
          decisionLogs={decisionLogs}
        />
      </div>

      {/* Bottom Right Synchronized 2D Minimap & Camera Instructions */}
      <div style={{ position: 'absolute', bottom: 20, right: 20, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px', zIndex: 10 }}>
        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.7)', background: 'rgba(0,0,0,0.6)', padding: '4px 10px', borderRadius: '6px' }}>
          Left Drag: Orbit • Right Drag: Pan • Wheel: Zoom
        </div>
        <Minimap
          terrain={terrain}
          roverPos={roverPos}
          path={plannerResult?.path ?? []}
          exploredOrder={plannerResult?.exploredOrder ?? []}
          start={start}
          goal={goal}
          onSelectGoal={handleSelectGoal}
        />
      </div>
    </div>
  );
};
export default App;
