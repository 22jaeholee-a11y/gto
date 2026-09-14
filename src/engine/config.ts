export const SEAT_NAMES_8 = ['UTG', 'UTG1', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];

export function seatNames(n: number): string[] {
  return SEAT_NAMES_8.slice(8 - n);
}

export interface SizingConfig {
  /** open raise-to in bb (non-SB) */
  open: number;
  /** SB open raise-to in bb */
  sbOpen: number;
  /** BB raise-to vs SB limp */
  iso: number;
  /** 3bet multiplier of the facing bet when in position postflop vs the raiser */
  threeBetIP: number;
  /** 3bet multiplier when out of position */
  threeBetOOP: number;
  /** extra multiplier of the facing bet per caller (squeeze) */
  squeezePerCaller: number;
  /** 4bet multiplier of the facing 3bet */
  fourBet: number;
  /** a sized raise is dropped (all-in only) when raise-to >= this fraction of the raiser's stack */
  allinThreshold: number;
}

export interface PostflopModel {
  /** equity realization multipliers by postflop order (first to act ... last to act), indexed by #players */
  eqrByPlayers: Record<number, number[]>;
  /** fraction of the flop pot each loser is assumed to additionally lose (capped by stack) */
  potGrowth: number;
  /** strength of hand-playability adjustments (0 = off) */
  playability: number;
  /**
   * extra equity realization of the last preflop raiser (initiative, range advantage), by whether the
   * raiser is last to act postflop (ip) or not (oop); 1 = none. Calibrated against flop solves.
   */
  aggressor?: { ip: number; oop: number };
}

export interface SolverConfig {
  /** stacks in bb, in preflop action order; last two seats are SB and BB */
  stacks: number[];
  sb: number;
  bb: number;
  /** big blind ante (paid by BB, dead money) */
  ante: number;
  /** payout per place, any unit (normalized internally) */
  payouts: number[];
  /** utility the solver optimizes */
  mode: 'icm' | 'chip';
  /**
   * temperature (bb) for softening near-indifferent choices after solving: actions whose EVs differ by
   * less than a few multiples of this share the frequency (logit response). 0 = keep the raw solution.
   */
  smoothing?: number;
  sizing: SizingConfig;
  allowLimp: boolean;
  allowColdCall: boolean;
  pushFoldOnly: boolean;
  postflop: PostflopModel;
  iterations: number;
}

export const DEFAULT_CONFIG: SolverConfig = {
  stacks: [25, 25, 25, 25, 25, 25, 25, 25],
  sb: 0.5,
  bb: 1,
  ante: 1,
  payouts: [30, 20, 14, 10, 8, 7, 6, 5],
  mode: 'icm',
  sizing: {
    open: 2,
    sbOpen: 3,
    iso: 3.5,
    threeBetIP: 2.8,
    threeBetOOP: 3.6,
    squeezePerCaller: 1,
    fourBet: 2.3,
    allinThreshold: 0.42,
  },
  allowLimp: true,
  allowColdCall: true,
  pushFoldOnly: false,
  postflop: {
    eqrByPlayers: {
      2: [0.9, 1.06],
      3: [0.88, 0.95, 1.04],
      4: [0.86, 0.92, 0.96, 1.02],
    },
    potGrowth: 0.5,
    playability: 1,
    // calibrated against flop solves on 44 heads-up lines (8-max 20/30/50bb, 6-max 25bb): the effect of
    // being the preflop raiser nets out at ×1.007, so it stays neutral (see .audit/calibrate-eqr.ts)
    aggressor: { ip: 1, oop: 1 },
  },
  iterations: 400,
  // 0.15bb: in an 8-max 33bb ICM spot a 0.08bb gap splits about 78/20; exploitability rises to ~0.08bb
  smoothing: 0.15,
};
