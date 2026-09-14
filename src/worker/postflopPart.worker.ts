import { PostflopSolver, type PostflopPass, type PostflopUtil } from '../engine/postflop/solver';
import { buildPostflopTree, type PostflopSpot } from '../engine/postflop/tree';

export type ToPart =
  | { type: 'init'; spot: PostflopSpot; ranges: [Float64Array, Float64Array]; cards: number[] }
  | { type: 'run'; p: 0 | 1; pass: PostflopPass; util: PostflopUtil; t: number; children: Int32Array; reachP: Float64Array; reachO: Float64Array };

let solver: PostflopSolver | null = null;
const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<ToPart>) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      solver = new PostflopSolver(buildPostflopTree(m.spot), m.ranges, { role: 'worker', cards: m.cards });
      post({ type: 'ready' });
      return;
    }
    const s = solver!;
    const np = s.active[m.p].length;
    const no = s.active[1 - m.p].length;
    const items = Array.from(m.children, (child, i) => ({
      child,
      reachP: m.reachP.subarray(i * np, (i + 1) * np),
      reachO: m.reachO.subarray(i * no, (i + 1) * no),
    }));
    const outs = s.runItems(m.p, m.pass, m.util, m.t, items);
    const flat = new Float64Array(outs.length * np);
    outs.forEach((o, i) => flat.set(o, i * np));
    post({ type: 'out', out: flat }, [flat.buffer]);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
