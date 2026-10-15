import React from 'react';

export interface TimeBarProps {
  iso: string;
  playing: boolean;
  speed: number;
  onPlay: () => void;
  onSpeed: (s: number) => void;
  onStep: (sec: number) => void;
  onNow: () => void;
  onPick: (iso: string) => void;
}

const SPEEDS: { label: string; value: number }[] = [
  { label: '1×', value: 60 },
  { label: '60×', value: 3_600 },
  { label: '1h/s', value: 3_600 * 10 },
  { label: '1d/s', value: 86_400 },
  { label: '1w/s', value: 86_400 * 7 },
  { label: '1mo/s', value: 86_400 * 30 },
];

export const TimeBar: React.FC<TimeBarProps> = ({
  iso,
  playing,
  speed,
  onPlay,
  onSpeed,
  onStep,
  onNow,
  onPick,
}) => {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(iso.slice(0, 16));
  React.useEffect(() => {
    if (!editing) setDraft(iso.slice(0, 16));
  }, [iso, editing]);

  return (
    <div className="timebar" role="group" aria-label="Simulation time controls">
      <button
        className="icon-btn"
        aria-pressed={playing}
        aria-label={playing ? 'Pause time' : 'Play time'}
        onClick={onPlay}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <div className="time-sep" aria-hidden />
      {SPEEDS.map((s) => (
        <button
          key={s.label}
          className="chip"
          aria-pressed={speed === s.value}
          onClick={() => onSpeed(s.value)}
        >
          {s.label}
        </button>
      ))}
      <div className="time-sep" aria-hidden />
      <button className="icon-btn" aria-label="Step back one hour" onClick={() => onStep(-3_600)}>−1h</button>
      <button className="icon-btn" aria-label="Step forward one hour" onClick={() => onStep(3_600)}>+1h</button>
      <button className="icon-btn" aria-label="Step forward one day" onClick={() => onStep(86_400)}>+1d</button>
      <div className="time-sep" aria-hidden />
      {editing ? (
        <input
          autoFocus
          value={draft}
          aria-label="Requested epoch (UTC)"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false);
            const d = new Date(`${draft}:00Z`);
            if (!Number.isNaN(d.getTime())) onPick(d.toISOString());
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setEditing(false);
          }}
          style={{
            background: 'rgba(255,255,255,0.08)', border: '1px solid var(--accent)',
            borderRadius: 7, color: 'var(--text)', padding: '6px 8px', fontSize: 12,
            fontFamily: 'var(--mono)', width: 152, outline: 'none',
          }}
        />
      ) : (
        <button
          className="time-readout"
          onClick={() => setEditing(true)}
          title="Click to set a UTC epoch"
          style={{ background: 'none', border: 'none', cursor: 'pointer' }}
        >
          {iso.replace('T', ' ')}
        </button>
      )}
      <button className="icon-btn" aria-label="Reset to now" onClick={onNow}>now</button>
    </div>
  );
};
