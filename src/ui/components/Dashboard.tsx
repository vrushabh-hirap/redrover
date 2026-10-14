import React from 'react';
import { Play, Pause, StepForward, RotateCcw, Cpu, Battery, Compass, Mountain, Activity, Layers } from 'lucide-react';
import { GridCoord, PlannerMetrics } from '../../core/types';
import { PlannerType } from '../../planners/searchAlgorithms';

interface DashboardProps {
  algorithm: PlannerType;
  onSelectAlgorithm: (alg: PlannerType) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onStep: () => void;
  onReset: () => void;
  onResetCamera: () => void;
  roverPos: GridCoord;
  headingDeg: number;
  pitchDeg: number;
  battery: number; // percentage (0 - 100)
  currentElevation: number;
  currentSlope: number;
  metrics: PlannerMetrics | null;
  decisionLogs: string[];
}

export const Dashboard: React.FC<DashboardProps> = ({
  algorithm,
  onSelectAlgorithm,
  isPlaying,
  onTogglePlay,
  onStep,
  onReset,
  onResetCamera,
  roverPos,
  headingDeg,
  pitchDeg,
  battery,
  currentElevation,
  currentSlope,
  metrics,
  decisionLogs,
}) => {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        width: '360px',
        maxHeight: 'calc(100vh - 100px)',
        overflowY: 'auto',
        padding: '18px',
        borderRadius: '16px',
        background: 'rgba(23, 14, 18, 0.85)',
        backdropFilter: 'blur(16px)',
        border: '1px solid rgba(244, 63, 94, 0.2)',
        boxShadow: '0 20px 40px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
        color: '#f3f4f6',
        fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      }}
    >
      {/* 1. Algorithm Selection Header */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
          <Cpu size={16} color="#fb7185" />
          <span style={{ fontSize: '13px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#fda4af' }}>
            Mission Planner
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '6px' }}>
          {(['astar', 'ucs', 'greedy', 'bfs', 'dfs'] as PlannerType[]).map((alg) => {
            const active = algorithm === alg;
            return (
              <button
                key={alg}
                onClick={() => onSelectAlgorithm(alg)}
                style={{
                  padding: '8px 2px',
                  borderRadius: '8px',
                  fontSize: '11px',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  border: active ? '1px solid #fb7185' : '1px solid rgba(255,255,255,0.08)',
                  background: active ? 'linear-gradient(135deg, #e11d48, #be123c)' : 'rgba(255,255,255,0.04)',
                  color: active ? '#ffffff' : '#9ca3af',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                {alg === 'astar' ? 'A*' : alg.toUpperCase()}
              </button>
            );
          })}
        </div>
      </div>

      {/* 2. Simulation Playback Controls */}
      <div>
        <span style={{ fontSize: '11px', fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Traverse Controls
        </span>
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
          <button
            onClick={onTogglePlay}
            style={{
              flex: 2,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              padding: '10px 14px',
              borderRadius: '8px',
              fontSize: '12px',
              fontWeight: 700,
              border: 'none',
              background: isPlaying ? '#e11d48' : '#10b981',
              color: '#ffffff',
              cursor: 'pointer',
              transition: 'background 0.2s ease',
            }}
          >
            {isPlaying ? <Pause size={14} /> : <Play size={14} />}
            {isPlaying ? 'PAUSE' : 'AUTOPILOT'}
          </button>

          <button
            onClick={onStep}
            disabled={isPlaying}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px',
              padding: '10px 8px',
              borderRadius: '8px',
              fontSize: '12px',
              fontWeight: 600,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.06)',
              color: isPlaying ? '#6b7280' : '#e5e7eb',
              cursor: isPlaying ? 'not-allowed' : 'pointer',
            }}
          >
            <StepForward size={14} />
            STEP
          </button>

          <button
            onClick={onReset}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px',
              padding: '10px 8px',
              borderRadius: '8px',
              fontSize: '12px',
              fontWeight: 600,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.06)',
              color: '#e5e7eb',
              cursor: 'pointer',
            }}
          >
            <RotateCcw size={14} />
            RESET
          </button>
        </div>

        <button
          onClick={onResetCamera}
          style={{
            width: '100%',
            marginTop: '8px',
            padding: '6px 10px',
            borderRadius: '6px',
            fontSize: '11px',
            fontWeight: 600,
            border: '1px dashed rgba(255,255,255,0.15)',
            background: 'transparent',
            color: '#cbd5e1',
            cursor: 'pointer',
          }}
        >
          Reset Camera (Orbit 45° / Zoom 70m)
        </button>
      </div>

      {/* 3. Rover Telemetry Grid */}
      <div style={{ background: 'rgba(0,0,0,0.3)', padding: '12px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' }}>
          <Activity size={15} color="#38bdf8" />
          <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7dd3fc' }}>
            Rover Telemetry (Simulated)
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Compass size={14} color="#94a3b8" />
            <span>Grid: <strong>({roverPos.x}, {roverPos.y})</strong></span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Battery size={14} color={battery > 30 ? '#10b981' : '#ef4444'} />
            <span>Battery: <strong>{battery.toFixed(1)}%</strong></span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Mountain size={14} color="#94a3b8" />
            <span>Elev: <strong>{currentElevation.toFixed(1)}m</strong></span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Layers size={14} color="#94a3b8" />
            <span>Slope: <strong>{currentSlope.toFixed(1)}°</strong></span>
          </div>

          <div style={{ gridColumn: 'span 2', fontSize: '11px', color: '#9ca3af' }}>
            Heading: <strong>{headingDeg.toFixed(0)}°</strong> | Pitch: <strong>{pitchDeg.toFixed(1)}°</strong>
          </div>
        </div>
      </div>

      {/* 4. Planner Metrics Panel */}
      {metrics && (
        <div style={{ background: 'rgba(0,0,0,0.35)', padding: '12px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', color: '#fbcfe8' }}>
              Algorithm Metrics
            </span>
            <span style={{ fontSize: '11px', color: '#38bdf8', fontWeight: 700 }}>
              {metrics.planningTimeMs} ms
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '12px', marginBottom: '8px' }}>
            <div>Path Cost: <strong style={{ color: '#34d399' }}>{metrics.pathCost.toFixed(2)}</strong></div>
            <div>Waypoints: <strong>{metrics.steps}</strong></div>
            <div>Nodes Expanded: <strong>{metrics.expandedNodes}</strong></div>
            <div>Peak Frontier: <strong>{metrics.peakFrontier}</strong></div>
          </div>

          <div style={{ fontSize: '11px', color: '#cbd5e1', fontStyle: 'italic', background: 'rgba(255,255,255,0.03)', padding: '6px 8px', borderRadius: '6px' }}>
            "{metrics.optimalityNote}"
          </div>
        </div>
      )}

      {/* 5. Autopilot & Decision Log */}
      <div>
        <span style={{ fontSize: '11px', fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Mission Decision Log
        </span>
        <div
          style={{
            marginTop: '6px',
            height: '110px',
            overflowY: 'auto',
            background: 'rgba(0,0,0,0.5)',
            borderRadius: '8px',
            padding: '8px',
            fontSize: '11px',
            fontFamily: 'monospace',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            border: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          {decisionLogs.slice(-20).map((log, idx) => (
            <div key={idx} style={{ color: log.includes('ERR') ? '#f87171' : log.includes('SUCCESS') ? '#4ade80' : '#d1d5db' }}>
              {log}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
