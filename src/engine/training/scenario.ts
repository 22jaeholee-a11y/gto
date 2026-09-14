import { DEFAULT_CONFIG, type SolverConfig } from '../config';

export interface TrainingSettings {
  players: number;
  minStack: number;
  maxStack: number;
  /** probability that a scenario uses chip EV instead of ICM */
  chipEvShare: number;
  iterations: number;
}

export const DEFAULT_TRAINING: TrainingSettings = {
  players: 8,
  minStack: 10,
  maxStack: 45,
  chipEvShare: 0.15,
  iterations: 300,
};

export interface PayoutPreset {
  key: 'top' | 'flat' | 'bubble' | 'itm';
  /** short, plain name shown in the table header */
  name: string;
  /** one-line meaning for players */
  hint: string;
  payouts: (players: number) => number[];
}

export const PAYOUT_PRESETS: PayoutPreset[] = [
  { key: 'top', name: '상위 집중형', hint: '1등 상금이 커서 칩을 모으는 가치가 큰 구조예요', payouts: (n) => [30, 20, 14, 10, 8, 7, 6, 5].slice(0, n) },
  { key: 'flat', name: '고른 분배형', hint: '순위별 상금 차이가 작아 살아남는 가치가 커요 (ICM 압박 강함)', payouts: (n) => [22, 16, 13, 11, 10, 10, 9, 9].slice(0, n) },
  { key: 'bubble', name: '버블', hint: '한 명만 더 떨어지면 모두 상금권이라 탈락을 가장 피해야 해요', payouts: (n) => [30, 20, 15, 12, 9, 7, 7].slice(0, n - 1) },
  { key: 'itm', name: '막 입상한 직후', hint: '모두 상금은 확보했고, 순위를 올리는 싸움이에요', payouts: (n) => [26, 17, 13, 11, 9, 8, 8, 8].slice(0, n) },
];

export interface ScenarioInfo {
  players: number;
  avgStack: number;
  ante: number;
  mode: 'icm' | 'chip';
  /** payout structure name and meaning; null in chip EV mode */
  payout: { name: string; hint: string } | null;
  paidPlaces: number;
  /** each place's share of the prize pool (0..1) */
  payoutShares: number[];
  heroStack: number | null;
  /** 1 = biggest stack */
  heroRank: number | null;
}

/** Structured, human-friendly description of a table; works for scenarios saved before names changed. */
export function describeScenario(config: SolverConfig, heroSeat?: number): ScenarioInfo {
  const n = config.stacks.length;
  const total = config.payouts.reduce((a, b) => a + b, 0) || 1;
  const shares = config.payouts.map((p) => p / total);
  const paidPlaces = shares.filter((x) => x > 0).length;
  let payout: ScenarioInfo['payout'] = null;
  if (config.mode === 'icm') {
    const match = PAYOUT_PRESETS.find((p) => {
      const arr = p.payouts(n);
      const t = arr.reduce((a, b) => a + b, 0);
      return arr.length === shares.length && arr.every((v, i) => Math.abs(v / t - shares[i]) < 1e-6);
    });
    if (match) payout = { name: match.name, hint: match.hint };
    else if (paidPlaces < n) payout = { name: '버블', hint: `${n}명 중 ${paidPlaces}명만 상금을 받아요` };
    else payout = { name: '사용자 상금표', hint: `1등이 상금의 ${Math.round(shares[0] * 100)}%를 가져가요` };
  }
  const heroStack = heroSeat === undefined ? null : config.stacks[heroSeat];
  const heroRank = heroStack === null ? null : 1 + config.stacks.filter((x) => x > heroStack).length;
  return {
    players: n,
    avgStack: config.stacks.reduce((a, b) => a + b, 0) / n,
    ante: config.ante,
    mode: config.mode,
    payout,
    paidPlaces,
    payoutShares: shares,
    heroStack,
    heroRank,
  };
}

export interface Scenario {
  id: string;
  label: string;
  config: SolverConfig;
  createdAt: number;
}

export type Rand = () => number;

export function mulberry32(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random tournament table: stacks log-uniform in [minStack, maxStack], random payout structure. */
export function randomScenario(rand: Rand, settings: TrainingSettings = DEFAULT_TRAINING): Scenario {
  const n = settings.players;
  const lo = Math.log(settings.minStack), hi = Math.log(settings.maxStack);
  const stacks = Array.from({ length: n }, () => Math.round(Math.exp(lo + rand() * (hi - lo)) * 2) / 2);
  const chip = rand() < settings.chipEvShare;
  const preset = PAYOUT_PRESETS[Math.floor(rand() * PAYOUT_PRESETS.length)];
  const ante = rand() < 0.85 ? 1 : 0;
  const avg = stacks.reduce((a, b) => a + b, 0) / n;
  const config: SolverConfig = {
    ...DEFAULT_CONFIG,
    stacks,
    ante,
    mode: chip ? 'chip' : 'icm',
    payouts: chip ? [1] : preset.payouts(n),
    iterations: settings.iterations,
  };
  const label = `${n}인 · 평균 ${avg.toFixed(0)}bb · ${chip ? '칩 기준(Chip EV)' : preset.name}`;
  return { id: `${Date.now().toString(36)}-${Math.floor(rand() * 1e9).toString(36)}`, label, config, createdAt: Date.now() };
}
