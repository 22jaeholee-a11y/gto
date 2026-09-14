import type { ReactNode } from 'react';

/** Small "i" badge that reveals its explanation on hover, keyboard focus, or tap. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="info-tip" tabIndex={0} role="button" aria-label={`${label} 설명`}>
      <span aria-hidden>i</span>
      <span className="info-tip-body" role="tooltip">{children}</span>
    </span>
  );
}
