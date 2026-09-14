import type { SolverConfig } from '../engine/config';
import { exportPart } from '../engine/parallel';
import { Solver, type Pass } from '../engine/solver';
import { buildTree } from '../engine/tree';

export type ToSubtree =
  | { type: 'init'; config: SolverConfig; roots: number[] }
  | { type: 'run'; pass: Pass; util: 'icm' | 'chip'; t: number; ids: Int32Array; reach: Float64Array; store: boolean }
  | { type: 'export' };

let solver: Solver | null = null;
let stores: { icm: Float32Array; chip: Float32Array } | null = null;
const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<ToSubtree>) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      solver = new Solver(buildTree(m.config), { roots: m.roots });
      stores = { icm: new Float32Array(solver.stratSum.length), chip: new Float32Array(solver.stratSum.length) };
      post({ type: 'ready' });
    } else if (m.type === 'run') {
      const out = solver!.runSubtrees(m.pass, m.util, m.t, m.ids, m.reach, m.store ? stores![m.util] : undefined);
      post({ type: 'out', out }, [out.buffer]);
    } else if (m.type === 'export') {
      const part = exportPart(solver!, stores!.icm, stores!.chip);
      post({ type: 'export', part }, [part.dIndex.buffer, part.strategy.buffer, part.evIcm.buffer, part.evChip.buffer]);
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
