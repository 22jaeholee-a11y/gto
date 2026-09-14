import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config';
import { finalize, Solver } from '../solver';
import { buildTree } from '../tree';
import { decodeStrategy, encodeStrategy } from './poolcodec';

describe('pool codec', () => {
  it('round-trips a solved strategy and reproduces its EVs', () => {
    const config = { ...DEFAULT_CONFIG, stacks: [18, 25, 14, 30, 22, 16], payouts: [40, 25, 15, 12, 8], iterations: 120 };
    const tree = buildTree(config);
    const solver = new Solver(tree);
    solver.run(120);
    const res = finalize(solver);

    const decoded = decodeStrategy(tree, encodeStrategy(tree, res.offsets, res.strategy));
    expect(Array.from(decoded.offsets)).toEqual(Array.from(res.offsets));
    let maxErr = 0;
    for (let i = 0; i < res.strategy.length; i++) maxErr = Math.max(maxErr, Math.abs(res.strategy[i] - decoded.strategy[i]));
    expect(maxErr).toBeLessThan(0.01);

    // EVs recomputed from the decoded strategy match the solver's, including rarely reached nodes
    const hydrated = new Solver(tree);
    hydrated.stratSum.set(decoded.strategy);
    const evIcm = new Float32Array(res.strategy.length);
    const root = hydrated.evaluate('icm', evIcm);
    let evErr = 0, count = 0;
    for (let i = 0; i < evIcm.length; i++) {
      if (!Number.isFinite(res.evIcm[i]) || !Number.isFinite(evIcm[i])) continue;
      evErr = Math.max(evErr, Math.abs(res.evIcm[i] - evIcm[i]));
      count++;
    }
    expect(count).toBeGreaterThan(1000);
    expect(evErr).toBeLessThan(0.05);
    root.forEach((v, p) => expect(v).toBeCloseTo(res.rootIcm[p], 3));
  }, 120_000);

  it('rejects files from a different tree', () => {
    const a = buildTree({ ...DEFAULT_CONFIG, stacks: [20, 20, 20], payouts: [50, 30, 20] });
    const b = buildTree({ ...DEFAULT_CONFIG, stacks: [20, 20, 60], payouts: [50, 30, 20] });
    const s = new Solver(a);
    s.run(5);
    const r = finalize(s);
    const bytes = encodeStrategy(a, r.offsets, r.strategy);
    expect(() => decodeStrategy(b, bytes)).toThrow();
  });
});
