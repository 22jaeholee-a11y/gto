import { useCallback, useEffect, useRef, useState } from 'react';
import type { SolverConfig } from '../engine/config';
import type { SolveResult } from '../engine/solver';
import type { FromWorker, LightTree } from '../worker/protocol';

export type SolveStatus = 'idle' | 'building' | 'solving' | 'done' | 'error';

export interface SolveState {
  status: SolveStatus;
  tree: LightTree | null;
  result: SolveResult | null;
  iteration: number;
  total: number;
  exploitability?: number;
  elapsedMs: number;
  threads: number;
  error?: string;
}

const initial: SolveState = { status: 'idle', tree: null, result: null, iteration: 0, total: 0, elapsedMs: 0, threads: 0 };

export function useSolver() {
  const [state, setState] = useState<SolveState>(initial);
  const worker = useRef<Worker | null>(null);

  const stop = useCallback(() => {
    worker.current?.terminate();
    worker.current = null;
    setState((s) => (s.status === 'building' || s.status === 'solving' ? { ...s, status: s.result ? 'done' : 'idle' } : s));
  }, []);

  const start = useCallback((config: SolverConfig) => {
    worker.current?.terminate();
    const w = new Worker(new URL('../worker/solver.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    setState({ ...initial, status: 'building', total: config.iterations });
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === 'tree') setState((s) => ({ ...s, status: 'solving', tree: m.tree }));
      else if (m.type === 'progress')
        setState((s) => ({ ...s, iteration: m.iteration, total: m.total, exploitability: m.exploitability ?? s.exploitability, elapsedMs: m.elapsedMs, threads: m.threads }));
      else if (m.type === 'done') {
        setState((s) => ({ ...s, status: 'done', result: m.result, exploitability: m.result.exploitability, elapsedMs: m.elapsedMs, iteration: m.result.iterations }));
        w.terminate();
        worker.current = null;
      } else if (m.type === 'error') {
        setState((s) => ({ ...s, status: 'error', error: m.message }));
        w.terminate();
        worker.current = null;
      }
    };
    w.onerror = (ev) => setState((s) => ({ ...s, status: 'error', error: ev.message || '워커 오류' }));
    w.postMessage({ type: 'solve', config });
  }, []);

  useEffect(() => () => worker.current?.terminate(), []);

  return { state, start, stop };
}
