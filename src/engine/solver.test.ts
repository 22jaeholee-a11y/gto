import { describe, expect, it } from 'vitest';
import { COMBOS, classLabel, NUM_CLASSES } from './cards';
import { DEFAULT_CONFIG, type SolverConfig } from './config';
import { finalize, Solver } from './solver';
import { buildTree, type DecisionNode } from './tree';

const cfg = (over: Partial<SolverConfig>): SolverConfig => ({ ...DEFAULT_CONFIG, ...over });
const idx = (label: string) => Array.from({ length: NUM_CLASSES }, (_, i) => classLabel(i)).indexOf(label);

function freq(strategy: Float32Array, off: number, action: number, hand: string) {
  return strategy[off + action * NUM_CLASSES + idx(hand)];
}

function rangePct(strategy: Float32Array, off: number, action: number) {
  let s = 0;
  for (let h = 0; h < NUM_CLASSES; h++) s += COMBOS[h] * strategy[off + action * NUM_CLASSES + h];
  return s / 1326;
}

describe('Solver', () => {
  it('heads-up 10bb chipEV push/fold converges to known Nash ranges', () => {
    const tree = buildTree(cfg({ stacks: [10, 10], ante: 0, pushFoldOnly: true, mode: 'chip', payouts: [1], iterations: 0 }));
    const solver = new Solver(tree);
    solver.run(1000);
    const res = finalize(solver);
    const root = tree.nodes[0] as DecisionNode;
    const call = tree.nodes[root.actions[1].child] as DecisionNode;
    const offRoot = res.offsets[root.dIndex];
    const offCall = res.offsets[call.dIndex];
    const push = rangePct(res.strategy, offRoot, 1);
    const callPct = rangePct(res.strategy, offCall, 1);
    console.log(`HU10: push=${(push * 100).toFixed(1)}% call=${(callPct * 100).toFixed(1)}% expl=${res.exploitability.toFixed(4)}bb`);
    // published HU Nash at 10bb (no ante): SB shoves ~58%, BB calls ~37%
    expect(push).toBeGreaterThan(0.5);
    expect(push).toBeLessThan(0.66);
    expect(callPct).toBeGreaterThan(0.3);
    expect(callPct).toBeLessThan(0.44);
    expect(freq(res.strategy, offRoot, 1, 'AA')).toBeGreaterThan(0.99);
    expect(freq(res.strategy, offRoot, 1, '72o')).toBeLessThan(0.05);
    expect(freq(res.strategy, offCall, 1, 'AA')).toBeGreaterThan(0.99);
    expect(res.exploitability).toBeLessThan(0.02);
    // EV of shoving AA must exceed folding
    expect(res.evChip[offRoot + 1 * NUM_CLASSES + idx('AA')]).toBeGreaterThan(res.evChip[offRoot + idx('AA')]);
    // fold EV for SB is exactly -0.5bb
    expect(res.evChip[offRoot + idx('72o')]).toBeCloseTo(-0.5, 5);
  });

  it('ICM bubble makes calling tighter than chipEV', () => {
    const base = { stacks: [20, 20, 20], ante: 0, pushFoldOnly: true, iterations: 0 } as const;
    const run = (mode: 'icm' | 'chip', payouts: number[]) => {
      const tree = buildTree(cfg({ ...base, stacks: [...base.stacks], mode, payouts }));
      const s = new Solver(tree);
      s.run(600);
      const res = finalize(s);
      // BTN shoves, SB folds, BB decision
      const root = tree.nodes[0] as DecisionNode;
      const sb = tree.nodes[root.actions[1].child] as DecisionNode;
      const bb = tree.nodes[sb.actions[0].child] as DecisionNode;
      return rangePct(res.strategy, res.offsets[bb.dIndex], 1);
    };
    const chip = run('chip', [1]);
    const icm = run('icm', [0.5, 0.5]); // bubble: 2 paid of 3
    console.log(`BB call vs BTN shove: chip=${(chip * 100).toFixed(1)}% icm-bubble=${(icm * 100).toFixed(1)}%`);
    expect(icm).toBeLessThan(chip * 0.7);
  });

  it('8-max 25bb full tree iteration speed', () => {
    const tree = buildTree(cfg({ iterations: 0 }));
    const s = new Solver(tree);
    const t0 = performance.now();
    s.run(20);
    const dt = (performance.now() - t0) / 20;
    const t1 = performance.now();
    const e = s.exploitability();
    console.log(`8-max: ${tree.numDecisions} decisions, ${dt.toFixed(1)} ms/iter, expl pass ${(performance.now() - t1).toFixed(0)} ms, expl=${e.toFixed(3)}`);
    expect(Number.isFinite(e)).toBe(true);
  }, 120_000);
});
