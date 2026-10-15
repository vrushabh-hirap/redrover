import React from 'react';

export type Mode = 'explorer' | 'mission' | 'traffic';

export interface BodyHit {
  name: string;
  kind: 'planet' | 'moon' | 'star';
  subtitle: string;
}

const BODIES: BodyHit[] = [
  { name: 'Sun', kind: 'star', subtitle: 'G2V star' },
  { name: 'Mercury', kind: 'planet', subtitle: 'Terrestrial planet' },
  { name: 'Venus', kind: 'planet', subtitle: 'Terrestrial planet' },
  { name: 'Earth', kind: 'planet', subtitle: 'Home world · traffic mode target' },
  { name: 'Moon', kind: 'moon', subtitle: 'Natural satellite of Earth' },
  { name: 'Mars', kind: 'planet', subtitle: 'Terrestrial planet' },
  { name: 'Jupiter', kind: 'planet', subtitle: 'Gas giant · 4 large moons' },
  { name: 'Io', kind: 'moon', subtitle: 'Galilean moon of Jupiter' },
  { name: 'Europa', kind: 'moon', subtitle: 'Galilean moon of Jupiter' },
  { name: 'Ganymede', kind: 'moon', subtitle: 'Largest moon in the Solar System' },
  { name: 'Callisto', kind: 'moon', subtitle: 'Galilean moon of Jupiter' },
  { name: 'Saturn', kind: 'planet', subtitle: 'Ringed gas giant · Titan' },
  { name: 'Titan', kind: 'moon', subtitle: 'Moon of Saturn' },
  { name: 'Uranus', kind: 'planet', subtitle: 'Ice giant' },
  { name: 'Neptune', kind: 'planet', subtitle: 'Ice giant' },
];

export interface TopBarProps {
  mode: Mode;
  onMode: (m: Mode) => void;
  query: string;
  onQuery: (q: string) => void;
  results: BodyHit[];
  onResult: (r: BodyHit) => void;
  epochIso: string;
  dataLabel: string;
  dataStatus: 'live' | 'bundled' | 'synthetic' | 'unavailable';
  onData: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  mode,
  onMode,
  query,
  onQuery,
  results,
  onResult,
  epochIso,
  dataLabel,
  dataStatus,
  onData,
}) => {
  const [focused, setFocused] = React.useState(false);
  const show = focused && query.trim().length > 0;
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden>◎</div>
        <div className="brand-text">
          <div className="brand-name">RedRover</div>
          <div className="brand-sub">Solar System Explorer</div>
        </div>
      </div>

      <div className="modeswitch" role="tablist" aria-label="Application mode">
        {(
          [
            ['explorer', 'Explorer'],
            ['mission', 'Mission Planner'],
            ['traffic', 'Orbital Traffic'],
          ] as [Mode, string][]
        ).map(([m, label]) => (
          <button
            key={m}
            role="tab"
            className="mode-btn"
            data-mode={m}
            aria-pressed={mode === m}
            aria-selected={mode === m}
            onClick={() => onMode(m)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="searchbox">
        <span className="icon" aria-hidden>⌕</span>
        <input
          type="search"
          value={query}
          aria-label="Search bodies and cataloged objects"
          placeholder="Search a body, moon or satellite…"
          onChange={(e) => onQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 160)}
        />
        {show && results.length > 0 && (
          <div className="search-results" role="listbox" aria-label="Search results">
            {results.map((r) => (
              <button
                key={r.name}
                className="search-item"
                role="option"
                aria-selected={false}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onResult(r);
                  onQuery('');
                  setFocused(false);
                }}
              >
                <span>{r.name}</span>
                <span className="meta">{r.subtitle}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="topbar-right">
        <div className="epoch-chip" title="Requested simulation epoch (UTC)">
          {epochIso}
        </div>
        <button className="data-btn" data-status={dataStatus} onClick={onData} aria-label="Data sources and epoch">
          <span className="dot" aria-hidden />
          {dataLabel}
        </button>
      </div>
    </header>
  );
};

export { BODIES as SEARCHABLE_BODIES };
