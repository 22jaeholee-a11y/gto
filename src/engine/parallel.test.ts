import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './config';
import { Coordinator, LocalExecutor, planPartition } from './parallel';
import { finalize, Solver } from './solver';
import { buildTree } from './tree';

describe('parallel coordinator', () => {
  it('matches the single-threaded solver exactly (up to float noise)', async () => {
    const tree = buildTree({ ...DEFAULT_CONFIG, stacks: [15, 15, 15, 15, 15, 15], iterations: 0 });
    const plan = planPartition(tree, 4, 0)!;
    expect(plan).not.toBeNull();
    expect(plan.frontier.length).toBeGreaterThan(4);

    const single = new Solver(tree);
    single.run(30);
    const a = finalize(single);

    const coord = new Coordinator(tree, plan, new LocalExecutor(tree, plan));
    await coord.run(30);
    const b = await coord.finalize();

    expect(b.strategy.length).toBe(a.strategy.length);
    let maxDiff = 0;
    for (let i = 0; i < a.strategy.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a.strategy[i] - b.strategy[i]));
    expect(maxDiff).toBeLessThan(1e-5);
    let evDiff = 0;
    for (let i = 0; i < a.evIcm.length; i++) {
      if (Number.isNaN(a.evIcm[i])) { expect(Number.isNaN(b.evIcm[i])).toBe(true); continue; }
      evDiff = Math.max(evDiff, Math.abs(a.evIcm[i] - b.evIcm[i]));
    }
    expect(evDiff).toBeLessThan(1e-4);
    expect(b.exploitability).toBeCloseTo(a.exploitability, 6);
    a.rootIcm.forEach((v, i) => expect(b.rootIcm[i]).toBeCloseTo(v, 8));
  }, 120_000);
});
