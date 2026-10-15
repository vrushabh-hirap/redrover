import React from 'react';
import { Tag } from './common';

export interface SourceBlock {
  title: string;
  kind: 'live' | 'bundled' | 'synthetic' | 'unavailable' | 'info';
  rows: [string, string][];
  note?: string;
}

export interface DataPanelProps {
  open: boolean;
  onClose: () => void;
  blocks: SourceBlock[];
  requestedEpoch: string;
  staleWarning: string | null;
}

const KIND_LABEL: Record<SourceBlock['kind'], string> = {
  live: 'LIVE',
  bundled: 'CACHED SNAPSHOT',
  synthetic: 'SYNTHETIC',
  unavailable: 'UNAVAILABLE',
  info: 'NOT LOADED',
};

export const DataPanel: React.FC<DataPanelProps> = ({ open, onClose, blocks, requestedEpoch, staleWarning }) => {
  if (!open) return null;
  return (
    <section className="data-panel" aria-label="Data sources and epochs">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 12, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--accent)' }}>
          Data sources &amp; epoch
        </strong>
        <button className="close-btn" aria-label="Close data panel" onClick={onClose}>✕</button>
      </div>

      <div className="note">
        <strong>Requested simulation epoch</strong>
        <br />
        <span style={{ fontFamily: 'var(--mono)' }}>{requestedEpoch.replace('T', ' ')}</span>
        <br />
        This is the time you asked for. It is reported separately from the epoch of each source
        record below.
      </div>

      {staleWarning &&
        staleWarning.split('\n\n').map((w, i) => (
          <div className="note warn" key={i}>
            {w}
          </div>
        ))}

      {blocks.map((b) => (
        <div className="source-row" key={b.title}>
          <h4>
            <span style={{ flex: 1 }}>{b.title}</span>
            <Tag label={KIND_LABEL[b.kind]} kind={b.kind === 'info' ? 'moon' : b.kind} />
          </h4>
          {b.rows.map(([k, v]) => (
            <p key={k}>
              <strong style={{ color: 'var(--text)' }}>{k}:</strong> {v}
            </p>
          ))}
          {b.note && <p style={{ marginTop: 5, color: 'var(--text-faint)' }}>{b.note}</p>}
        </div>
      ))}

      <div className="note warn">
        Educational simulation. Nothing here is a certified spacecraft trajectory, a conjunction
        assessment, or a complete debris environment.
      </div>
    </section>
  );
};
