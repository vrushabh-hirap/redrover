import React from 'react';
import type { FlightProgressData } from '../scene/SolarScene';

interface FlightSimulationHudProps {
  flight: FlightProgressData;
  originName: string;
  destinationName: string;
  onPlayPause: () => void;
  onReplay: () => void;
  onSeek: (t: number) => void;
  onSpeed: (speed: number) => void;
  onToggleFollow: () => void;
  onClose: () => void;
}

function fmt(n: number, d = 0): string {
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : '—';
}

export const FlightSimulationHud: React.FC<FlightSimulationHudProps> = ({
  flight,
  originName,
  destinationName,
  onPlayPause,
  onReplay,
  onSeek,
  onSpeed,
  onToggleFollow,
  onClose,
}) => {
  if (!flight.active) return null;

  const pct = Math.round(flight.progress * 100);

  return (
    <aside
      className="flight-hud"
      aria-label="Mission flight simulation controls"
      style={{
        position: 'absolute',
        top: 64,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 25,
        width: 'min(580px, 92vw)',
        background: 'rgba(11, 19, 36, 0.88)',
        backdropFilter: 'blur(18px)',
        WebkitBackdropFilter: 'blur(18px)',
        border: '1px solid rgba(56, 189, 248, 0.4)',
        borderRadius: 14,
        boxShadow: '0 12px 36px rgba(0, 0, 0, 0.65), 0 0 24px rgba(56, 189, 248, 0.2)',
        padding: '12px 16px',
        color: '#f8fafc',
        fontFamily: 'inherit',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        pointerEvents: 'auto',
      }}
    >
      {/* Top Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              display: 'inline-block',
              width: 9,
              height: 9,
              borderRadius: '50%',
              backgroundColor: flight.completed ? '#22c55e' : '#38bdf8',
              boxShadow: flight.completed
                ? '0 0 10px #22c55e'
                : '0 0 10px #38bdf8',
              animation: flight.playing ? 'pulse 1.4s infinite' : 'none',
            }}
          />
          <strong
            style={{
              fontSize: 11,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: flight.completed ? '#4ade80' : '#38bdf8',
            }}
          >
            {flight.completed ? 'Mission Arrival Reached' : 'Live Flight Simulation'}
          </strong>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={onToggleFollow}
            className="chip"
            style={{
              fontSize: 10,
              padding: '3px 8px',
              borderRadius: 6,
              background: flight.followCamera ? 'rgba(56, 189, 248, 0.25)' : 'rgba(255, 255, 255, 0.06)',
              borderColor: flight.followCamera ? '#38bdf8' : 'rgba(255, 255, 255, 0.15)',
              color: flight.followCamera ? '#38bdf8' : 'var(--text-dim)',
            }}
            title="Toggle camera tracking spacecraft"
          >
            🎥 {flight.followCamera ? 'Following' : 'Free Cam'}
          </button>
          <button
            className="close-btn"
            onClick={onClose}
            aria-label="Exit flight simulation"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              padding: '2px 4px',
            }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Trajectory Title */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9' }}>
          {originName} <span style={{ color: '#38bdf8', margin: '0 4px' }}>➔</span> {destinationName}
        </div>
        <div style={{ fontSize: 11, color: '#38bdf8', fontWeight: 600 }}>
          {pct}%
        </div>
      </div>

      {/* Current Stage */}
      <div style={{ fontSize: 11, color: '#cbd5e1', background: 'rgba(255, 255, 255, 0.04)', padding: '5px 8px', borderRadius: 6, border: '1px solid rgba(255, 255, 255, 0.08)' }}>
        <span style={{ color: '#94a3b8', fontSize: 10, textTransform: 'uppercase', marginRight: 6 }}>
          Stage {flight.stageIndex + 1}/{flight.totalStages}:
        </span>
        <strong style={{ color: '#f8fafc' }}>{flight.currentStageName}</strong>
      </div>

      {/* Interactive Progress Scrubber */}
      <div style={{ position: 'relative', width: '100%', height: 18, display: 'flex', alignItems: 'center' }}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.002}
          value={flight.progress}
          onChange={(e) => onSeek(parseFloat(e.target.value))}
          aria-label="Simulation progress scrubber"
          style={{
            width: '100%',
            height: 6,
            appearance: 'none',
            background: `linear-gradient(to right, #0284c7 0%, #38bdf8 ${pct}%, rgba(255, 255, 255, 0.15) ${pct}%, rgba(255, 255, 255, 0.15) 100%)`,
            borderRadius: 3,
            cursor: 'pointer',
            outline: 'none',
          }}
        />
      </div>

      {/* Flight Telemetry Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, fontSize: 10 }}>
        <div style={{ background: 'rgba(15, 23, 42, 0.6)', padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(255, 255, 255, 0.05)' }}>
          <div style={{ color: '#94a3b8', marginBottom: 2 }}>Distance Traveled</div>
          <div style={{ fontWeight: 600, color: '#e2e8f0', fontSize: 11 }}>
            {fmt(flight.traveledKm)} / {fmt(flight.totalKm)} km
          </div>
        </div>
        <div style={{ background: 'rgba(15, 23, 42, 0.6)', padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(255, 255, 255, 0.05)' }}>
          <div style={{ color: '#94a3b8', marginBottom: 2 }}>Velocity Proxy</div>
          <div style={{ fontWeight: 600, color: '#38bdf8', fontSize: 11 }}>
            {fmt(flight.speedMs)} m/s
          </div>
        </div>
        <div style={{ background: 'rgba(15, 23, 42, 0.6)', padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(255, 255, 255, 0.05)' }}>
          <div style={{ color: '#94a3b8', marginBottom: 2 }}>Status</div>
          <div style={{ fontWeight: 600, color: flight.completed ? '#4ade80' : '#f59e0b', fontSize: 11 }}>
            {flight.completed ? 'Arrived ✓' : flight.playing ? 'Thrusters firing' : 'Paused'}
          </div>
        </div>
      </div>

      {/* Control Buttons */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onClick={onPlayPause}
            className="btn btn-primary"
            style={{
              padding: '5px 12px',
              fontSize: 11,
              fontWeight: 700,
              minWidth: 70,
            }}
          >
            {flight.completed ? '↺ Replay' : flight.playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <button
            onClick={onReplay}
            className="btn"
            style={{ padding: '5px 10px', fontSize: 11 }}
            title="Restart flight from launch"
          >
            ↺ Restart
          </button>
        </div>

        {/* Speed Multiplier Chips */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: '#94a3b8', marginRight: 2 }}>Speed:</span>
          {[1, 2, 5, 10].map((s) => (
            <button
              key={s}
              onClick={() => onSpeed(s)}
              className="chip"
              style={{
                padding: '2px 6px',
                fontSize: 10,
                borderRadius: 4,
                background: flight.speed === s ? 'rgba(56, 189, 248, 0.25)' : 'rgba(255, 255, 255, 0.05)',
                borderColor: flight.speed === s ? '#38bdf8' : 'rgba(255, 255, 255, 0.1)',
                color: flight.speed === s ? '#38bdf8' : '#94a3b8',
                fontWeight: flight.speed === s ? 700 : 400,
              }}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
};
