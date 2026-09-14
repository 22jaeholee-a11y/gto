import type { SolverConfig } from '../engine/config';
import type { SolveResult } from '../engine/solver';
import type { DecisionNode, TerminalNode } from '../engine/tree';

export type LightDecision = Omit<DecisionNode, never>;
export type LightTerminal = Omit<TerminalNode, 'utilIcm' | 'utilChip' | 'outcomes' | 'eqr' | 'playScale'>;
export type LightNode = LightDecision | LightTerminal;

export interface LightTree {
  numPlayers: number;
  seatNames: string[];
  nodes: LightNode[];
  numDecisions: number;
  startIcm: number[];
  config: SolverConfig;
}

export type ToWorker = { type: 'solve'; config: SolverConfig; /** cap on worker threads (default: device budget) */ maxThreads?: number };

export type FromWorker =
  | { type: 'tree'; tree: LightTree; buildMs: number }
  | { type: 'progress'; iteration: number; total: number; exploitability?: number; elapsedMs: number; threads: number }
  | { type: 'done'; result: SolveResult; elapsedMs: number }
  | { type: 'error'; message: string };
