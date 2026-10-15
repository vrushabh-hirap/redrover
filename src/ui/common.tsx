import React from 'react';

export const Panel: React.FC<{ children: React.ReactNode; style?: React.CSSProperties; className?: string }> = ({
  children,
  style,
  className,
}) => <div className={className} style={style}>{children}</div>;

export const Stat: React.FC<{ label: string; value: React.ReactNode; color?: string }> = ({ label, value, color }) => (
  <div className="stat">
    <div className="stat-value" style={{ color: color ?? 'var(--accent)' }}>{value}</div>
    <div className="stat-label">{label}</div>
  </div>
);

export const Tag: React.FC<{ label: string; kind?: string }> = ({ label, kind = 'planet' }) => (
  <span className={`tag ${kind}`}>{label}</span>
);

export const Toggle: React.FC<{
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  id?: string;
}> = ({ checked, onChange, label, id }) => (
  <div className="toggle-row">
    <span>{label}</span>
    <button
      id={id}
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    />
  </div>
);

export const fmt = (n: number, digits = 0): string => {
  if (!Number.isFinite(n)) return '∞';
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

export const fmtKm = (km: number): string => {
  if (!Number.isFinite(km)) return '—';
  if (Math.abs(km) >= 1e6) return `${(km / 1e6).toFixed(2)} million km`;
  if (Math.abs(km) >= 1e3) return `${fmt(km)} km`;
  return `${fmt(km, 1)} km`;
};

export const fmtDuration = (sec: number): string => {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 90) return `${sec.toFixed(0)} s`;
  const m = sec / 60;
  if (m < 90) return `${m.toFixed(1)} min`;
  const h = m / 60;
  if (h < 72) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
};

export const utc = (d: Date): string => d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';

export const utcShort = (d: Date): string => d.toISOString().slice(0, 16) + 'Z';
