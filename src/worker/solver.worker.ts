import type { SolverConfig } from '../engine/config';
import { Coordinator, planPartition, type PartExport, type SubtreeExecutor } from '../engine/parallel';
import { finalize, Solver, type Pass } from '../engine/solver';
import { buildTree, type GameTree, type TerminalNode } from '../engine/tree';
import type { FromWorker, LightNode, ToWorker } from './protocol';
import type { ToSubtree } from './subtree.worker';

const post = (msg: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
const EXPL_EVERY = 50;

/** One pending request per worker at a time: the coordinator awaits every part before the next pass. */
class WorkerExecutor implements SubtreeExecutor {
  private workers: Worker[];
  private pending: Array<{ resolve: (v: any) => void; reject: (e: Error) => void } | null>;

  private constructor(workers: Worker[]) {
    this.workers = workers;
    this.pending = workers.map(() => null);
    workers.forEach((w, i) => {
      w.onmessage = (e) => {
        const p = this.pending[i];
        this.pending[i] = null;
        if (!p) return;
        if (e.data.type === 'error') p.reject(new Error(e.data.message));
        else p.resolve(e.data);
      };
      w.onerror = (e) => {
        const p = this.pending[i];
        this.pending[i] = null;
        p?.reject(new Error(e.message || '서브 워커 오류'));
      };
    });
  }

  static async create(config: SolverConfig, assignment: number[][]): Promise<WorkerExecutor> {
    const workers = assignment.map(() => new Worker(new URL('./subtree.worker.ts', import.meta.url), { type: 'module' }));
    const exec = new WorkerExecutor(workers);
    try {
      // some mobile browsers lack nested workers or stall loading them; fall back after a timeout
      await withTimeout(Promise.all(assignment.map((roots, i) => exec.request(i, { type: 'init', config, roots }))), 20000);
    } catch (err) {
      exec.terminate();
      throw err;
    }
    return exec;
  }

  private request(i: number, msg: ToSubtree, transfer: Transferable[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      this.pending[i] = { resolve, reject };
      this.workers[i].postMessage(msg, transfer);
    });
  }

  async run(part: number, pass: Pass, util: 'icm' | 'chip', t: number, ids: Int32Array, reach: Float64Array, store: boolean) {
    const res = await this.request(part, { type: 'run', pass, util, t, ids, reach, store }, [ids.buffer, reach.buffer]);
    return res.out as Float64Array;
  }

  async exportPart(part: number) {
    const res = await this.request(part, { type: 'export' });
    return res.part as PartExport;
  }

  terminate() {
    this.workers.forEach((w) => w.terminate());
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('서브 워커 응답 없음')), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** Threads to use: leave a core for the UI, and stay modest on phones to limit memory. */
function threadBudget(): number {
  const nav = (self as unknown as { navigator?: Navigator & { deviceMemory?: number } }).navigator;
  const cores = nav?.hardwareConcurrency ?? 4;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(nav?.userAgent ?? '');
  const memory = nav?.deviceMemory;
  let cap = mobile ? 4 : 12;
  if (memory !== undefined && memory <= 4) cap = Math.min(cap, 3);
  return Math.max(1, Math.min(cores - 1, cap));
}

async function solveParallel(tree: GameTree, threads: number, t0: number) {
  const plan = planPartition(tree, threads);
  if (!plan) return null;
  let exec: WorkerExecutor;
  try {
    exec = await WorkerExecutor.create(tree.config, plan.assignment);
  } catch {
    return null; // nested workers unavailable: fall back to a single thread
  }
  try {
    const coord = new Coordinator(tree, plan, exec);
    const total = tree.config.iterations;
    let expl: number | undefined;
    while (coord.iteration < total) {
      await coord.run(Math.min(5, total - coord.iteration));
      const it = coord.iteration;
      if (it % EXPL_EVERY === 0 && it < total) expl = await coord.exploitability();
      post({ type: 'progress', iteration: it, total, exploitability: expl, elapsedMs: performance.now() - t0, threads: plan.assignment.length });
    }
    return await coord.finalize();
  } catch {
    return null; // a sub-worker failed (e.g. killed for memory): redo on a single thread
  } finally {
    exec.terminate();
  }
}

function solveSingle(tree: GameTree, t0: number) {
  const solver = new Solver(tree);
  const total = tree.config.iterations;
  let expl: number | undefined;
  while (solver.iterations < total) {
    solver.run(Math.min(5, total - solver.iterations));
    const it = solver.iterations;
    if (it % EXPL_EVERY === 0 && it < total) expl = solver.exploitability();
    post({ type: 'progress', iteration: it, total, exploitability: expl, elapsedMs: performance.now() - t0, threads: 1 });
  }
  return finalize(solver);
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  if (e.data.type !== 'solve') return;
  const { config, maxThreads } = e.data;
  try {
    const t0 = performance.now();
    const tree = buildTree(config);
    const nodes: LightNode[] = tree.nodes.map((nd) => {
      if (nd.kind === 'decision') return nd;
      const { utilIcm: _a, utilChip: _b, outcomes: _c, eqr: _d, playScale: _e, ...rest } = nd as TerminalNode;
      return rest;
    });
    post({ type: 'tree', tree: { ...tree, nodes }, buildMs: performance.now() - t0 });

    const threads = Math.max(1, Math.min(threadBudget(), maxThreads ?? Infinity));
    const t1 = performance.now();
    const result = (await solveParallel(tree, threads, t1)) ?? solveSingle(tree, t1);
    post({ type: 'done', result, elapsedMs: performance.now() - t1 }, [
      result.strategy.buffer, result.evIcm.buffer, result.evChip.buffer, result.offsets.buffer,
    ]);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
