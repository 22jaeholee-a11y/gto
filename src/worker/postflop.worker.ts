import { dispatchItems, hasChance, riverCards, splitCards } from '../engine/postflop/parallel';
import { PostflopSolver, type ChanceExecutor, type ChanceItem, type PostflopPass, type PostflopResult, type PostflopUtil } from '../engine/postflop/solver';
import { buildPostflopTree, type PostflopSpot } from '../engine/postflop/tree';
import type { ToPart } from './postflopPart.worker';

export type ToPostflop = { type: 'solve'; id: number; spot: PostflopSpot; ranges: [Float64Array, Float64Array]; threads: number };
export type FromPostflop =
  | { type: 'progress'; id: number; fraction: number }
  | { type: 'done'; id: number; result: PostflopResult; ms: number }
  | { type: 'error'; id: number; message: string };

const post = (msg: FromPostflop, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

/** iterations per street: river trees are tiny, turn trees include every river */
const ITERATIONS: Record<PostflopSpot['street'], number> = { flop: 200, turn: 120, river: 300 };

class PartExecutor implements ChanceExecutor {
  private workers: Worker[] = [];
  private groups: number[][];
  private pending: Array<((v: any) => void) | null> = [];
  private failed: Array<((e: Error) => void) | null> = [];

  constructor(private spot: PostflopSpot, private ranges: [Float64Array, Float64Array], private solver: PostflopSolver, cards: number[], threads: number) {
    this.groups = splitCards(cards, threads);
  }

  async init(): Promise<void> {
    this.workers = this.groups.map(() => new Worker(new URL('./postflopPart.worker.ts', import.meta.url), { type: 'module' }));
    this.pending = this.workers.map(() => null);
    this.failed = this.workers.map(() => null);
    this.workers.forEach((w, i) => {
      w.onmessage = (e) => {
        const res = this.pending[i];
        const rej = this.failed[i];
        this.pending[i] = null;
        this.failed[i] = null;
        if (e.data.type === 'error') rej?.(new Error(e.data.message));
        else res?.(e.data);
      };
      w.onerror = (e) => this.failed[i]?.(new Error(e.message || 'postflop part worker failed'));
    });
    await Promise.all(this.groups.map((cards, i) => this.request(i, { type: 'init', spot: this.spot, ranges: this.ranges, cards })));
  }

  private request(i: number, msg: ToPart, transfer: Transferable[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      this.pending[i] = resolve;
      this.failed[i] = reject;
      this.workers[i].postMessage(msg, transfer);
    });
  }

  run(p: 0 | 1, pass: PostflopPass, util: PostflopUtil, t: number, items: ChanceItem[]): Promise<Map<number, Float64Array>> {
    const np = this.solver.active[p].length;
    const no = this.solver.active[1 - p].length;
    return dispatchItems(items, this.groups, async (part, list) => {
      const children = Int32Array.from(list, (it) => it.child);
      const reachP = new Float64Array(list.length * np);
      const reachO = new Float64Array(list.length * no);
      list.forEach((it, k) => { reachP.set(it.reachP, k * np); reachO.set(it.reachO, k * no); });
      const res = await this.request(part, { type: 'run', p, pass, util, t, children, reachP, reachO }, [children.buffer, reachP.buffer, reachO.buffer]);
      const flat = res.out as Float64Array;
      return list.map((_, k) => flat.subarray(k * np, (k + 1) * np));
    });
  }

  terminate() {
    this.workers.forEach((w) => w.terminate());
  }
}

self.onmessage = async (e: MessageEvent<ToPostflop>) => {
  const m = e.data;
  if (m.type !== 'solve') return;
  const t0 = performance.now();
  let exec: PartExecutor | null = null;
  try {
    const tree = buildPostflopTree(m.spot);
    const total = ITERATIONS[m.spot.street];
    const parallel = hasChance(tree) && m.threads > 1;
    const solver = new PostflopSolver(tree, m.ranges, parallel ? { role: 'coordinator' } : { role: 'all' });
    if (parallel) {
      exec = new PartExecutor(m.spot, m.ranges, solver, riverCards(tree), m.threads);
      await exec.init();
    }
    const step = Math.max(1, Math.round(total / 20));
    for (let it = 0; it < total; it += step) {
      const k = Math.min(step, total - it);
      if (exec) await solver.runAsync(k, exec);
      else solver.run(k);
      post({ type: 'progress', id: m.id, fraction: (it + k) / (total + 8) });
    }
    const result = exec ? await solver.finalizeAsync(exec) : solver.finalize();
    const transfer: Transferable[] = [];
    for (const arr of [...result.strategy, ...result.evIcm, ...result.evChip]) transfer.push(arr.buffer);
    post({ type: 'done', id: m.id, result, ms: performance.now() - t0 }, transfer);
  } catch (err) {
    post({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) });
  } finally {
    exec?.terminate();
  }
};
