import type { ActionReview, Verdict } from '../../engine/training/hand';

export interface SessionStats {
  hands: number;
  decisions: number;
  verdicts: Record<Verdict, number>;
  /** EV lost, converted to big blinds */
  lossBB: number;
  chipResult: number;
  icmResult: number;
}

const KEY = 'icm-preflop-lab.training-stats.v1';

export const EMPTY_STATS: SessionStats = {
  hands: 0,
  decisions: 0,
  verdicts: { best: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, info: 0 },
  lossBB: 0,
  chipResult: 0,
  icmResult: 0,
};

export function loadStats(): SessionStats {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...EMPTY_STATS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return EMPTY_STATS;
}

export function saveStats(s: SessionStats) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export function addReview(s: SessionStats, r: ActionReview): SessionStats {
  return {
    ...s,
    decisions: s.decisions + 1,
    verdicts: { ...s.verdicts, [r.verdict]: s.verdicts[r.verdict] + 1 },
    lossBB: s.lossBB + (r.verdict === 'info' ? 0 : r.lossBB),
  };
}

export function accuracy(s: SessionStats): number | null {
  const graded = s.decisions - s.verdicts.info;
  if (graded <= 0) return null;
  return (s.verdicts.best + s.verdicts.good) / graded;
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  best: '최선',
  good: 'GTO 혼합',
  inaccuracy: '부정확',
  mistake: '실수',
  blunder: '큰 실수',
  info: '참고',
};
