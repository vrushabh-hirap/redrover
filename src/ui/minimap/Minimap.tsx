import React, { useEffect, useRef } from 'react';
import { TerrainData, GridCoord } from '../../core/types';

interface MinimapProps {
  terrain: TerrainData;
  roverPos: GridCoord;
  path: GridCoord[];
  exploredOrder: GridCoord[];
  start: GridCoord;
  goal: GridCoord;
  onSelectGoal?: (coord: GridCoord) => void;
}

export const Minimap: React.FC<MinimapProps> = ({
  terrain,
  roverPos,
  path,
  start,
  goal,
  onSelectGoal,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height, cells, minElevation, maxElevation } = terrain;
    const elevRange = Math.max(1, maxElevation - minElevation);

    const cellW = canvas.width / width;
    const cellH = canvas.height / height;

    // 1. Draw base elevation and hazards
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const cell = cells[y][x];
        const normElev = (cell.elevation - minElevation) / elevRange;

        if (cell.isHazard) {
          ctx.fillStyle = '#1c1917'; // Hazard basalt dark
        } else if (cell.slope > 14) {
          ctx.fillStyle = '#7c2d12'; // High slope red-brown
        } else {
          // Martian gradient from deep rust to lighter ochre
          const r = Math.floor(130 + normElev * 90);
          const g = Math.floor(40 + normElev * 60);
          const b = Math.floor(25 + normElev * 30);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
        }

        ctx.fillRect(x * cellW, y * cellH, cellW + 0.5, cellH + 0.5);
      }
    }

    // 2. Draw planned route
    if (path.length > 1) {
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (let i = 0; i < path.length; i++) {
        const px = (path[i].x + 0.5) * cellW;
        const py = (path[i].y + 0.5) * cellH;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    // 3. Draw Start Marker
    ctx.fillStyle = '#10b981';
    ctx.beginPath();
    ctx.arc((start.x + 0.5) * cellW, (start.y + 0.5) * cellH, cellW * 1.5, 0, Math.PI * 2);
    ctx.fill();

    // 4. Draw Goal Marker
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.arc((goal.x + 0.5) * cellW, (goal.y + 0.5) * cellH, cellW * 1.5, 0, Math.PI * 2);
    ctx.fill();

    // 5. Draw Rover Position
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc((roverPos.x + 0.5) * cellW, (roverPos.y + 0.5) * cellH, cellW * 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }, [terrain, roverPos, path, start, goal]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onSelectGoal || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const gx = Math.floor((clickX / rect.width) * terrain.width);
    const gy = Math.floor((clickY / rect.height) * terrain.height);

    if (gx >= 0 && gx < terrain.width && gy >= 0 && gy < terrain.height) {
      onSelectGoal({ x: gx, y: gy });
    }
  };

  return (
    <div style={{ position: 'relative', width: 180, height: 180, borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.15)', background: '#000' }}>
      <canvas
        ref={canvasRef}
        width={180}
        height={180}
        onClick={handleCanvasClick}
        style={{ cursor: onSelectGoal ? 'crosshair' : 'default', display: 'block' }}
        title="Synchronized 2D Minimap (Click to reassign Target)"
      />
      <div style={{ position: 'absolute', bottom: 4, left: 6, fontSize: 10, color: 'rgba(255,255,255,0.7)', textShadow: '0 1px 2px #000', pointerEvents: 'none', fontWeight: 600 }}>
        2D ORTHO MINIMAP
      </div>
    </div>
  );
};
