import React from 'react';
import { Stat, Tag, fmt, fmtDuration, fmtKm } from './common';

export interface BodyInspectorData {
  name: string;
  kind: 'star' | 'planet' | 'moon';
  radiusKm: number;
  parent: string | null;
  distanceFromSunKm?: number;
  distanceFromEarthKm?: number;
  source: string;
  epochIso: string;
  frame: string;
  units: string;
}

export interface SatInspectorData {
  name: string;
  noradId: number;
  type: 'payload' | 'rocket_body' | 'debris';
  inclinationDeg: number;
  altitudeKm: number;
  periodMin: number;
  epochIso: string;
  positionKm: { x: number; y: number; z: number };
  region: string;
  provider: string;
  retrievedAt: string;
}

export interface InspectorProps {
  body: BodyInspectorData | null;
  sat: SatInspectorData | null;
  onClose: () => void;
  onFocus: () => void;
  onSetDestination: () => void;
  onTrack: () => void;
}

export const Inspector: React.FC<InspectorProps> = ({
  body,
  sat,
  onClose,
  onFocus,
  onSetDestination,
  onTrack,
}) => {
  if (!body && !sat) return null;
  return (
    <section className="inspector" aria-label="Selection inspector">
      <div className="inspector-head">
        <div>
          <div className="inspector-title">{body?.name ?? sat?.name}</div>
          <div className="inspector-sub">
            {body
              ? `${body.kind === 'moon' ? `Moon of ${body.parent}` : body.kind} · ${fmtKm(body.radiusKm)} mean radius`
              : `NORAD ${sat!.noradId} · ${sat!.region}`}
          </div>
        </div>
        <button className="close-btn" aria-label="Close inspector" onClick={onClose}>✕</button>
      </div>

      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {body && <Tag label={body.kind} kind={body.kind} />}
        {sat && (
          <Tag
            label={sat.type === 'rocket_body' ? 'rocket body' : sat.type}
            kind={sat.type === 'rocket_body' ? 'rocket' : sat.type === 'debris' ? 'debris' : 'payload'}
          />
        )}
      </div>

      {body && (
        <>
          <div className="grid2">
            <Stat label="From Sun" value={body.distanceFromSunKm ? `${(body.distanceFromSunKm / 1.495978707e8).toFixed(3)} AU` : '—'} />
            <Stat label="From Earth" value={body.distanceFromEarthKm !== undefined ? `${fmt(body.distanceFromEarthKm)} km` : '—'} color="var(--warn)" />
          </div>
          <dl className="kv">
            <dt>Radius</dt>
            <dd>{fmtKm(body.radiusKm)}</dd>
            <dt>Parent</dt>
            <dd>{body.parent ?? '—'}</dd>
            <dt>Source</dt>
            <dd style={{ fontFamily: 'inherit', fontSize: 10 }}>{body.source}</dd>
            <dt>Requested epoch</dt>
            <dd>{body.epochIso}</dd>
            <dt>Frame / units</dt>
            <dd style={{ fontFamily: 'inherit', fontSize: 10 }}>{body.frame}, {body.units}</dd>
          </dl>
        </>
      )}

      {sat && (
        <>
          <div className="grid2">
            <Stat label="Altitude" value={`${fmt(sat.altitudeKm)} km`} />
            <Stat label="Period" value={`${sat.periodMin.toFixed(1)} min`} color="var(--good)" />
          </div>
          <div className="grid2">
            <Stat label="Inclination" value={`${sat.inclinationDeg.toFixed(2)}°`} color="var(--warn)" />
            <Stat label="Element epoch" value={sat.epochIso.slice(0, 10)} color="var(--traffic)" />
          </div>
          <dl className="kv">
            <dt>Position (TEME, km)</dt>
            <dd>{sat.positionKm.x.toFixed(0)}, {sat.positionKm.y.toFixed(0)}, {sat.positionKm.z.toFixed(0)}</dd>
            <dt>Provider</dt>
            <dd style={{ fontFamily: 'inherit', fontSize: 10 }}>{sat.provider}</dd>
            <dt>Retrieved</dt>
            <dd>{sat.retrievedAt.replace('T', ' ').slice(0, 19)}Z</dd>
            <dt>Position</dt>
            <dd>SGP4-propagated from catalog elements</dd>
          </dl>
          <div className="btn-row">
            <button className="btn" onClick={onTrack}>Track</button>
            <button className="btn btn-warn" onClick={onSetDestination}>Set destination</button>
          </div>
        </>
      )}

      {body && (
        <div className="btn-row">
          <button className="btn" onClick={onFocus}>Fly to</button>
          <button className="btn btn-warn" onClick={onSetDestination}>Set destination</button>
        </div>
      )}

      <div className="note">
        {body
          ? 'Positions are JPL Horizons vector ephemerides for the requested epoch (or the bundled snapshot when offline).'
          : 'This object is a tracked, cataloged object. Its position is an SGP4 estimate and degrades beyond roughly ±7 days of the element epoch. Untracked small debris has no public per-object position.'}
      </div>
    </section>
  );
};

export { fmtDuration };
