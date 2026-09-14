import type { SolverConfig } from '../../engine/config';
import type { PostflopResult } from '../../engine/postflop/solver';
import type { PostflopSpot } from '../../engine/postflop/tree';
import type { SolveResult } from '../../engine/solver';
import type { PostflopService } from '../../engine/training/hand';
import type { FromWorker } from '../../worker/protocol';
import type { FromPostflop, ToPostflop } from '../../worker/postflop.worker';

export function threadBudget(): number {
  const cores = navigator.hardwareConcurrency ?? 4;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  return Math.max(1, Math.min(cores - 1, mobile ? 4 : 12));
}

/** Solves one preflop configuration in a dedicated worker. */
export function solvePreflop(config: SolverConfig, onProgress?: (fraction: number) => void, maxThreads?: number): { promise: Promise<SolveResult>; cancel: () => void } {
  const w = new Worker(new URL('../../worker/solver.worker.ts', import.meta.url), { type: 'module' });
  let cancel = () => w.terminate();
  const promise = new Promise<SolveResult>((resolve, reject) => {
    cancel = () => { w.terminate(); reject(new Error('cancelled')); };
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.iteration / m.total);
      else if (m.type === 'done') { w.terminate(); resolve(m.result); }
      else if (m.type === 'error') { w.terminate(); reject(new Error(m.message)); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || '프리플랍 솔버 오류')); };
    w.postMessage({ type: 'solve', config, maxThreads });
  });
  return { promise, cancel };
}

/** Postflop solves through a long-lived coordinator worker. */
export class PostflopClient implements PostflopService {
  private worker: Worker | null = null;
  private seq = 0;
  private waiting = new Map<number, { resolve: (r: PostflopResult) => void; reject: (e: Error) => void; progress?: (x: number) => void }>();
  /** number of solves in flight (the scenario pool pauses while this is > 0) */
  active = 0;
  lastMs = 0;

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('../../worker/postflop.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<FromPostflop>) => {
      const m = e.data;
      const entry = this.waiting.get(m.id);
      if (!entry) return;
      if (m.type === 'progress') entry.progress?.(m.fraction);
      else {
        this.waiting.delete(m.id);
        this.active--;
        if (m.type === 'done') { this.lastMs = m.ms; entry.resolve(m.result); }
        else entry.reject(new Error(m.message));
      }
    };
    w.onerror = (e) => {
      for (const entry of this.waiting.values()) entry.reject(new Error(e.message || '포스트플랍 솔버 오류'));
      this.waiting.clear();
      this.active = 0;
      this.worker = null;
    };
    this.worker = w;
    return w;
  }

  solve(spot: PostflopSpot, ranges: [Float64Array, Float64Array], onProgress?: (fraction: number) => void): Promise<PostflopResult> {
    const id = ++this.seq;
    const w = this.ensure();
    this.active++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, progress: onProgress });
      const msg: ToPostflop = { type: 'solve', id, spot, ranges, threads: threadBudget() };
      w.postMessage(msg);
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
  }
}
