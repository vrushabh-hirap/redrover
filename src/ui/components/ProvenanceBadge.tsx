import React from 'react';
import { ShieldAlert, Info } from 'lucide-react';

interface ProvenanceBadgeProps {
  label: string;
  source: 'SYNTHETIC_FALLBACK' | 'NASA_DERIVED';
  description: string;
}

export const ProvenanceBadge: React.FC<ProvenanceBadgeProps> = ({
  label,
  source,
  description,
}) => {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '5px 12px',
        borderRadius: '9999px',
        fontSize: '11px',
        fontWeight: 700,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        backgroundColor: source === 'SYNTHETIC_FALLBACK' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.15)',
        color: source === 'SYNTHETIC_FALLBACK' ? '#fca5a5' : '#6ee7b7',
        border: `1px solid ${source === 'SYNTHETIC_FALLBACK' ? 'rgba(239, 68, 68, 0.4)' : 'rgba(16, 185, 129, 0.4)'}`,
        backdropFilter: 'blur(8px)',
      }}
      title={description}
    >
      {source === 'SYNTHETIC_FALLBACK' ? (
        <ShieldAlert size={14} style={{ color: '#ef4444' }} />
      ) : (
        <Info size={14} style={{ color: '#10b981' }} />
      )}
      <span>{label}</span>
    </div>
  );
};
