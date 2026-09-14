// Pre-built scenario pool: tables solved offline (scripts/build-pool.ts) and served as static files.

import { finalize, Solver, type SolveResult } from '../solver';
import type { GameTree } from '../tree';
import { decodeStrategy } from './poolcodec';
import type { Scenario, TrainingSettings } from './scenario';

/** bump when solver maths change without changing the tree shape, so stale pools are ignored */
export const PREBUILT_VERSION = 2;

export interface PrebuiltEntry {
  scenario: Scenario;
  /** file name relative to the manifest */
  file: string;
  bytes: number;
  decisions: number;
  iterations: number;
  exploitability: number;
}

export interface PrebuiltManifest {
  version: number;
  createdAt: string;
  entries: PrebuiltEntry[];
}

/** a table fits the training settings when its size matches and every stack lies inside the range */
export function fitsSettings(sc: Scenario, s: TrainingSettings): boolean {
  const c = sc.config;
  return c.stacks.length === s.players && Math.min(...c.stacks) >= s.minStack - 0.5 && Math.max(...c.stacks) <= s.maxStack + 0.5;
}

/** chip-EV share 0 means ICM tables only, 1 chip tables only; anything else accepts both */
export function fitsMode(sc: Scenario, s: TrainingSettings): boolean {
  if (s.chipEvShare <= 0) return sc.config.mode === 'icm';
  if (s.chipEvShare >= 1) return sc.config.mode === 'chip';
  return true;
}

/** Rebuilds a full solve result (strategy plus ICM and chip EVs) from a downloaded strategy file. */
export function hydrate(tree: GameTree, bytes: Uint8Array, exploitability: number, iterations: number): SolveResult {
  const { offsets, strategy } = decodeStrategy(tree, bytes);
  const solver = new Solver(tree);
  // the EV pass reads the average strategy from stratSum; a normalized strategy is a valid average
  for (const nd of tree.nodes) {
    if (nd.kind !== 'decision') continue;
    const from = offsets[nd.dIndex], to = solver.offsets[nd.dIndex];
    solver.stratSum.set(strategy.subarray(from, from + nd.actions.length * 169), to);
  }
  const res = finalize(solver, exploitability, { smooth: false });
  return { ...res, iterations };
}
