import { describe, expect, it } from 'vitest';
import { classLabel, NUM_CLASSES } from './cards';
import { DEFAULT_CONFIG } from './config';
import { payoutWithTies, referenceHand } from './reference';
import { finalize, Solver } from './solver';
import { buildTree, type DecisionNode } from './tree';

const idx = (label: string) => Array.from({ length: NUM_CLASSES }, (_, i) => classLabel(i)).indexOf(label);

describe('Monte Carlo reference', () => {
  it('splits tied side pots evenly', () => {
    // seat0 all-in 5, seats 1 and 2 put 20 and tie for best
    const win = payoutWithTies([5, 20, 20], [false, false, false], 0, [100, 200, 200]);
    expect(win[0]).toBe(0);
    expect(win[1]).toBe(22.5);
    expect(win[2]).toBe(22.5);
  });

  it('agrees with solver EVs in a heads-up all-in spot', () => {
    const tree = buildTree({ ...DEFAULT_CONFIG, stacks: [10, 10], ante: 0, pushFoldOnly: true, mode: 'chip', payouts: [1], iterations: 0 });
    const solver = new Solver(tree);
    solver.run(300);
    const res = finalize(solver);
    const root = tree.nodes[0] as DecisionNode;
    const path = [root.actions.findIndex((a) => a.type === 'allin')];
    const bb = tree.nodes[root.actions[path[0]].child] as DecisionNode;
    for (const hand of ['AA', 'A5s', 'KTo', '76s']) {
      const h = idx(hand);
      const ref = referenceHand(tree, res, path, h, 30000, 7 + h);
      const off = res.offsets[bb.dIndex];
      for (let a = 0; a < bb.actions.length; a++) {
        const solverEv = res.evChip[off + a * NUM_CLASSES + h];
        expect(Math.abs(solverEv - ref.evChip[a])).toBeLessThan(4 * ref.seChip[a] + 0.02);
      }
    }
  }, 120_000);
});
