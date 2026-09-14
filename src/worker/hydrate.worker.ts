// Turns a downloaded pre-built strategy into a full solve result (EVs are recomputed here).

import type { SolverConfig } from '../engine/config';
import type { SolveResult } from '../engine/solver';
import { hydrate } from '../engine/training/prebuilt';
import { buildTree } from '../engine/tree';

export type ToHydrate = { config: SolverConfig; bytes: Uint8Array; exploitability: number; iterations: number };
export type FromHydrate = { type: 'done'; result: SolveResult } | { type: 'error'; message: string };

self.onmessage = (e: MessageEvent<ToHydrate>) => {
  const post = (msg: FromHydrate, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
  try {
    const { config, bytes, exploitability, iterations } = e.data;
    const result = hydrate(buildTree(config), bytes, exploitability, iterations);
    post({ type: 'done', result }, [result.strategy.buffer, result.evIcm.buffer, result.evChip.buffer]);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
