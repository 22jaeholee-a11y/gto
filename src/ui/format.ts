import type { ActType } from '../engine/tree';

export function signed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return '—';
  const s = x.toFixed(digits);
  return x > 0 && Number(s) !== 0 ? `+${s}` : s === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : s;
}

export function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function bb(x: number): string {
  return Number.isInteger(x) ? `${x}` : x.toFixed(x < 10 ? 2 : 1).replace(/0+$/, '').replace(/\.$/, '');
}

/** colors per action, raises get progressively darker by size rank */
export function actionColor(type: ActType, raiseRank = 0): string {
  switch (type) {
    case 'fold': return 'var(--act-fold)';
    case 'check':
    case 'call': return 'var(--act-call)';
    case 'raise': return raiseRank === 0 ? 'var(--act-raise)' : 'var(--act-raise-2)';
    case 'allin': return 'var(--act-allin)';
  }
}
