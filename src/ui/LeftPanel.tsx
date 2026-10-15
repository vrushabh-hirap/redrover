import React from 'react';
import { Stat, Toggle, Tag, fmt } from './common';

export type LeftTab = 'explore' | 'mission' | 'catalog' | 'layers';

export interface OriginState {
  name: string;
  lat: number;
  lon: number;
  source: 'surface-click' | 'site' | 'coords';
}

export interface DestinationState {
  id: string;
  name: string;
  kind: 'moon' | 'planet' | 'satellite';
  subtitle: string;
  distanceKm?: number;
}

export interface LeftPanelProps {
  open: boolean;
  tab: LeftTab;
  onTab: (t: LeftTab) => void;
  // explore
  bodies: { name: string; kind: string; distanceKm?: number }[];
  onFocusBody: (name: string) => void;
  onFrameSystem: (name: string) => void;
  onOverview: () => void;
  scaleLabel: string;
  // mission
  origin: OriginState | null;
  destination: DestinationState | null;
  onSetOriginMode: () => void;
  onSetDestinationMode: () => void;
  onClearOrigin: () => void;
  onClearDestination: () => void;
  launchSites: { name: string; lat: number; lon: number }[];
  onPickSite: (s: { name: string; lat: number; lon: number }) => void;
  algorithm: string;
  onAlgorithm: (a: string) => void;
  algorithms: { id: string; label: string; optimality: string; notes: string }[];
  costModel: string;
  onCostModel: (id: string) => void;
  costModels: { id: string; label: string; description: string }[];
  onPlan: () => void;
  onCompareAll: () => void;
  planning: boolean;
  // catalog
  catalogGroup: string;
  onCatalogGroup: (g: string) => void;
  groups: { id: string; label: string; description: string; approxObjects: string }[];
  catalogLoading: boolean;
  counts: { loaded: number; visible: number; filteredOut: number };
  catalogStatus: { provider: string; retrievedAt: string; elementEpochRange: string; detail: string; objectCount: number } | null;
  onImportTle: (file: File) => void;
  onRefreshLive: () => void;
  filters: {
    payload: boolean; rocketBody: boolean; debris: boolean;
    regions: string[]; nameQuery: string;
  };
  onFilters: (f: LeftPanelProps['filters']) => void;
  regionOptions: string[];
  // layers
  layers: { id: string; label: string; hint: string; value: boolean }[];
  onLayer: (id: string, v: boolean) => void;
}

export const LeftPanel: React.FC<LeftPanelProps> = (p) => {
  return (
    <aside className="panel" data-open={p.open} aria-hidden={!p.open} aria-label="Explorer controls">
      <div className="panel-tabs" role="tablist" aria-label="Panel sections">
        {(
          [
            ['explore', 'Explore'],
            ['mission', 'Mission'],
            ['catalog', 'Catalog'],
            ['layers', 'Layers'],
          ] as [LeftTab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            role="tab"
            className="panel-tab"
            aria-selected={p.tab === t}
            onClick={() => p.onTab(t)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="panel-body">
        {p.tab === 'explore' && (
          <>
            <div>
              <h3 className="section-title">Fly to</h3>
              <div className="grid2">
                {p.bodies.map((b) => (
                  <button key={b.name} className="btn" onClick={() => p.onFocusBody(b.name)}>
                    {b.name}
                  </button>
                ))}
              </div>
            </div>
            <button className="btn btn-primary btn-block" onClick={p.onOverview}>
              Solar System overview
            </button>
            <div className="grid2" style={{ marginTop: 6 }}>
              <button className="btn" onClick={() => p.onFrameSystem('Earth')}>Earth–Moon system</button>
              <button className="btn" onClick={() => p.onFrameSystem('Jupiter')}>Jovian system</button>
            </div>
            <p style={{ fontSize: 9, color: 'var(--text-faint)', margin: '6px 0 0', lineHeight: 1.6 }}>
              A planet close-up frames the body itself. Moon systems are 60+ body radii across, so
              use “Earth–Moon system” (or scroll out) to see a planet and its moons together.
            </p>
            <div className="note">
              <strong style={{ color: 'var(--accent)' }}>{p.scaleLabel}</strong>
              <br />
              Overview compresses heliocentric distance logarithmically and enlarges bodies so all
              eight planets stay navigable. Distances are <strong>not</strong> to scale. Focus view
              uses a true local scale: one body radius = 300 scene units.
            </div>
            <div>
              <h3 className="section-title">Distances from the Sun (requested epoch)</h3>
              <dl className="kv">
                {p.bodies
                  .filter((b) => b.kind === 'planet')
                  .map((b) => (
                    <React.Fragment key={b.name}>
                      <dt>{b.name}</dt>
                      <dd>{b.distanceKm ? `${(b.distanceKm / 1.495978707e8).toFixed(3)} AU` : '—'}</dd>
                    </React.Fragment>
                  ))}
              </dl>
            </div>
          </>
        )}

        {p.tab === 'mission' && (
          <>
            <div className="card origin">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <strong className="card-title" style={{ color: 'var(--origin)' }}>Launch origin</strong>
                {p.origin && (
                  <button className="close-btn" aria-label="Clear origin" onClick={p.onClearOrigin}>✕</button>
                )}
              </div>
              {p.origin ? (
                <>
                  <div className="card-title">{p.origin.name}</div>
                  <div className="card-mono">
                    lat {p.origin.lat.toFixed(3)}° · lon {p.origin.lon.toFixed(3)}° · Earth
                  </div>
                </>
              ) : (
                <div className="card-sub">No origin selected.</div>
              )}
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button className="btn btn-good" onClick={p.onSetOriginMode}>
                  Click Earth
                </button>
              </div>
            </div>

            <div>
              <h3 className="section-title">Or pick a launch site</h3>
              <div className="grid2">
                {p.launchSites.map((s) => (
                  <button
                    key={s.name}
                    className="btn"
                    aria-pressed={p.origin?.name === s.name}
                    onClick={() => p.onPickSite(s)}
                    title={`${s.lat.toFixed(2)}°, ${s.lon.toFixed(2)}°`}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="card destination">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <strong className="card-title" style={{ color: 'var(--destination)' }}>Destination</strong>
                {p.destination && (
                  <button className="close-btn" aria-label="Clear destination" onClick={p.onClearDestination}>✕</button>
                )}
              </div>
              {p.destination ? (
                <>
                  <div className="card-title">{p.destination.name}</div>
                  <div className="card-sub">{p.destination.subtitle}</div>
                  {p.destination.distanceKm !== undefined && (
                    <div className="card-mono">{fmt(p.destination.distanceKm)} km from Earth</div>
                  )}
                </>
              ) : (
                <div className="card-sub">No destination selected.</div>
              )}
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button className="btn btn-warn" onClick={p.onSetDestinationMode}>
                  Click or search a target
                </button>
              </div>
            </div>

            <div>
              <h3 className="section-title">Search algorithm</h3>
              <div className="chip-grid">
                {p.algorithms.map((a) => (
                  <button
                    key={a.id}
                    className="chip"
                    aria-pressed={p.algorithm === a.id}
                    onClick={() => p.onAlgorithm(a.id)}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
              <div className="note" style={{ marginTop: 7 }}>
                {p.algorithms.find((a) => a.id === p.algorithm)?.notes}
                <br />
                <strong>Optimality:</strong> {p.algorithms.find((a) => a.id === p.algorithm)?.optimality}
              </div>
            </div>

            <div>
              <h3 className="section-title">Route objective</h3>
              <div className="chip-grid">
                {p.costModels.map((m) => (
                  <button
                    key={m.id}
                    className="chip"
                    aria-pressed={p.costModel === m.id}
                    onClick={() => p.onCostModel(m.id)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <div className="note" style={{ marginTop: 7 }}>
                {p.costModels.find((m) => m.id === p.costModel)?.description}
              </div>
            </div>

            <div className="btn-row">
              <button className="btn btn-primary" onClick={p.onPlan} disabled={p.planning || !p.origin || !p.destination}>
                {p.planning ? 'Planning…' : 'Plan route'}
              </button>
              <button className="btn" onClick={p.onCompareAll} disabled={p.planning || !p.origin || !p.destination}>
                Compare all
              </button>
            </div>
            <div className="note warn">
              Every route above is a <strong>conceptual AI graph route</strong> through an abstract
              mission navigation graph. It is not a flight-certified trajectory, a verified Δv budget,
              or a conjunction assessment.
            </div>
          </>
        )}

        {p.tab === 'catalog' && (
          <>
            <div>
              <h3 className="section-title">Catalog group</h3>
              <div className="chip-grid">
                {p.groups.map((g) => (
                  <button
                    key={g.id}
                    className="chip"
                    aria-pressed={p.catalogGroup === g.id}
                    onClick={() => p.onCatalogGroup(g.id)}
                    title={g.description}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="btn-row">
              <button className="btn" onClick={p.onRefreshLive} disabled={p.catalogLoading}>
                {p.catalogLoading ? 'Loading…' : 'Refresh live'}
              </button>
              <label className="btn" style={{ cursor: 'pointer' }}>
                Import TLE
                <input
                  type="file"
                  accept=".tle,.txt"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) p.onImportTle(f);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>

            <div className="grid4">
              <Stat label="Loaded" value={fmt(p.counts.loaded)} color="var(--accent)" />
              <Stat label="Visible" value={fmt(p.counts.visible)} color="var(--good)" />
              <Stat label="Hidden" value={fmt(p.counts.filteredOut)} color="var(--warn)" />
              <Stat label="Region" value={p.filters.regions.length} color="var(--traffic)" />
            </div>

            <div>
              <h3 className="section-title">Filters</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                <Toggle label="Active payloads" checked={p.filters.payload} onChange={(v) => p.onFilters({ ...p.filters, payload: v })} />
                <Toggle label="Rocket bodies" checked={p.filters.rocketBody} onChange={(v) => p.onFilters({ ...p.filters, rocketBody: v })} />
                <Toggle label="Cataloged debris" checked={p.filters.debris} onChange={(v) => p.onFilters({ ...p.filters, debris: v })} />
              </div>
              <div className="chip-grid" style={{ marginTop: 8 }}>
                {p.regionOptions.map((r) => (
                  <button
                    key={r}
                    className="chip"
                    aria-pressed={p.filters.regions.includes(r)}
                    onClick={() =>
                      p.onFilters({
                        ...p.filters,
                        regions: p.filters.regions.includes(r)
                          ? p.filters.regions.filter((x) => x !== r)
                          : [...p.filters.regions, r],
                      })
                    }
                  >
                    {r}
                  </button>
                ))}
              </div>
              <div className="field" style={{ marginTop: 8 }}>
                <label htmlFor="sat-name-filter">Name or NORAD id</label>
                <input
                  id="sat-name-filter"
                  value={p.filters.nameQuery}
                  placeholder="e.g. ISS or 25544"
                  onChange={(e) => p.onFilters({ ...p.filters, nameQuery: e.target.value })}
                />
              </div>
            </div>

            {p.catalogStatus && (
              <div className="note">
                <strong>{p.catalogStatus.provider}</strong>
                <br />
                Retrieved {p.catalogStatus.retrievedAt.replace('T', ' ').slice(0, 19)}Z
                <br />
                Element epochs {p.catalogStatus.elementEpochRange}
                <br />
                {p.catalogStatus.detail}
              </div>
            )}
            <Tag label="Tracked objects only" kind={p.catalogStatus ? 'cached' : 'synthetic'} />
          </>
        )}

        {p.tab === 'layers' && (
          <>
            <div>
              <h3 className="section-title">Scene layers</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {p.layers.map((l) => (
                  <div key={l.id}>
                    <Toggle label={l.label} checked={l.value} onChange={(v) => p.onLayer(l.id, v)} id={`layer-${l.id}`} />
                    <div style={{ fontSize: 9, color: 'var(--text-faint)', marginTop: 2, marginLeft: 44 }}>{l.hint}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="note">
              Orbit rings are drawn from JPL approximate Keplerian elements. Object positions come
              from JPL Horizons vectors and SGP4-propagated catalog elements.
            </div>
          </>
        )}
      </div>
    </aside>
  );
};
