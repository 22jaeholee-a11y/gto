import { describe, expect, it } from 'vitest';
import { CLASS_COMBOS, COMBO_C1, COMBO_C2, NC, parseCard } from './combos';
import { PostflopSolver } from './solver';
import { buildPostflopTree, DEFAULT_POSTFLOP_SIZING, type PDecision, type PostflopSpot, type PostflopTree } from './tree';
import { classLabel, NUM_CLASSES } from '../cards';

const cls = (label: string) => Array.from({ length: NUM_CLASSES }, (_, i) => classLabel(i)).indexOf(label);
const board = (s: string) => s.split(' ').map(parseCard);

function rangeOf(labels: string[], dead: number[]): Float64Array {
  const r = new Float64Array(NC);
  for (const l of labels) for (const k of CLASS_COMBOS[cls(l)]) if (!dead.includes(COMBO_C1[k]) && !dead.includes(COMBO_C2[k])) r[k] = 1;
  return r;
}

function chipSpot(street: PostflopSpot['street'], b: number[], pot: number, stack: number, sizing = DEFAULT_POSTFLOP_SIZING): PostflopSpot {
  return {
    street,
    board: b,
    pot,
    sizing,
    icm: { mode: 'chip', payouts: [1], startStacks: [stack + pot / 2, stack + pot / 2], baseStacks: [stack, stack], seats: [0, 1] },
  };
}

function freqOver(res: ReturnType<PostflopSolver['finalize']>, tree: PostflopTree, nodeId: number, action: number, range: Float64Array) {
  const i = res.nodeIds.indexOf(nodeId);
  const nd = tree.nodes[nodeId] as PDecision;
  void nd;
  let num = 0, den = 0;
  for (let k = 0; k < NC; k++) if (range[k] > 0) { num += res.strategy[i][action * NC + k]; den += 1; }
  return num / den;
}

describe('postflop solver', () => {
  it('solves the polarized river bluff-catcher game', () => {
    // OOP: sets (value) + missed straight draws (air); IP: one pair bluff-catchers.
    const b = board('Ks Qd 7h 4c 2s');
    const pot = 10;
    const sizing = { ...DEFAULT_POSTFLOP_SIZING, river: { bets: [1], raises: [], allin: false }, allinThreshold: 1.01 };
    const spot = chipSpot('river', b, pot, 50, sizing);
    const tree = buildPostflopTree(spot);
    const value = rangeOf(['KK'], b); // 3 combos
    const air = rangeOf(['65s', '65o'], b); // 16 combos
    const oop = new Float64Array(NC);
    for (let k = 0; k < NC; k++) oop[k] = value[k] + air[k];
    const ip = rangeOf(['JJ'], b);
    const solver = new PostflopSolver(tree, [oop, ip]);
    solver.run(2000);
    const res = solver.finalize();
    const root = tree.nodes[0] as PDecision;
    const betIdx = root.actions.findIndex((a) => a.type === 'bet');
    const betNode = root.actions[betIdx].child;
    const callIdx = (tree.nodes[betNode] as PDecision).actions.findIndex((a) => a.type === 'call');

    const valueBet = freqOver(res, tree, 0, betIdx, value) * 3;
    const bluffCombos = freqOver(res, tree, 0, betIdx, air) * 16;
    const call = freqOver(res, tree, betNode, callIdx, ip);
    console.log(`value bets ${valueBet.toFixed(2)}/3 combos, bluffs ${bluffCombos.toFixed(2)} combos, IP calls ${(call * 100).toFixed(1)}%, expl ${res.exploitability.toFixed(4)}`);
    // pot-sized bet: bluffs = value / 2, bluff-catcher calls pot/(pot+bet) = 50%
    expect(valueBet).toBeGreaterThan(2.9);
    expect(bluffCombos).toBeGreaterThan(1.3);
    expect(bluffCombos).toBeLessThan(1.7);
    expect(call).toBeGreaterThan(0.45);
    expect(call).toBeLessThan(0.55);
    expect(res.exploitability).toBeLessThan(0.05);
    // IP indifferent between calling and folding
    const ipIdx = res.nodeIds.indexOf(betNode);
    const k = [...Array(NC).keys()].find((x) => ip[x] > 0)!;
    const evFold = res.evChip[ipIdx][0 * NC + k];
    const evCall = res.evChip[ipIdx][callIdx * NC + k];
    expect(Math.abs(evFold - evCall)).toBeLessThan(0.3);
  });

  it('turn solve with river subtrees stays consistent and zero-sum in chips', () => {
    const b = board('Ah 9c 6d 2s');
    const spot = chipSpot('turn', b, 12, 40);
    const tree = buildPostflopTree(spot);
    const oop = rangeOf(['AK', 'AQs', 'KQs', '99', '66', '87s', 'T8s', 'QJs', 'A5s', '76s'].flatMap((l) => (l.length === 2 && l[0] !== l[1] ? [l + 's', l + 'o'] : [l])), b);
    const ip = rangeOf(['AJo', 'ATs', 'KK', 'QQ', 'JJ', '98s', '65s', 'KJs', 'T9s', '33'], b);
    const solver = new PostflopSolver(tree, [oop, ip]);
    const t0 = performance.now();
    solver.run(150);
    const ms = performance.now() - t0;
    const res = solver.finalize();
    console.log(`turn: ${tree.nodes.length} nodes, ${tree.numDecisions} decisions, ${(ms / 150).toFixed(1)} ms/iter, expl ${res.exploitability.toFixed(3)}bb`);
    expect(res.exploitability).toBeLessThan(0.3);
    const root = res.strategy[0];
    const A = (tree.nodes[0] as PDecision).actions.length;
    for (let k = 0; k < NC; k++) {
      if (oop[k] === 0) continue;
      let s = 0;
      for (let a = 0; a < A; a++) s += root[a * NC + k];
      expect(s).toBeCloseTo(1, 4);
    }
  }, 120_000);

  it('flop depth-limited solve builds equity leaves', () => {
    const b = board('Jd 8s 3h');
    const spot = chipSpot('flop', b, 6, 30);
    const tree = buildPostflopTree(spot);
    const wide = new Float64Array(NC);
    for (let k = 0; k < NC; k++) wide[k] = k % 3 === 0 ? 1 : 0;
    for (const c of b) for (let k = 0; k < NC; k++) if (COMBO_C1[k] === c || COMBO_C2[k] === c) wide[k] = 0;
    const t0 = performance.now();
    const solver = new PostflopSolver(tree, [wide, wide.slice()]);
    const prep = performance.now() - t0;
    solver.run(150);
    const res = solver.finalize();
    console.log(`flop: ${tree.numDecisions} decisions, equity prep ${prep.toFixed(0)} ms, total ${(performance.now() - t0).toFixed(0)} ms, expl ${res.exploitability.toFixed(3)}bb`);
    expect(res.exploitability).toBeLessThan(0.3);
  }, 120_000);
});

describe('parallel turn solve', () => {
  it('matches the single-threaded solver', async () => {
    const { LocalChanceExecutor } = await import('./parallel');
    const b = board('Kd 7c 4h 2d');
    const spot = chipSpot('turn', b, 9, 25);
    const tree = buildPostflopTree(spot);
    const oop = rangeOf(['AK', 'KQs', '77', '44', '65s', '98s', 'A5s', 'QJs'].flatMap((l) => (l.length === 2 && l[0] !== l[1] ? [l + 's', l + 'o'] : [l])), b);
    const ip = rangeOf(['AQo', 'KJs', 'TT', '99', '86s', 'A4s', '33', 'JTs'], b);
    const single = new PostflopSolver(tree, [oop, ip]);
    single.run(25);
    const a = single.finalize();

    const coord = new PostflopSolver(tree, [oop, ip], { role: 'coordinator' });
    const exec = new LocalChanceExecutor(tree, [oop, ip], 3);
    await coord.runAsync(25, exec);
    const b2 = await coord.finalizeAsync(exec);

    expect(b2.nodeIds).toEqual(a.nodeIds);
    let maxDiff = 0, evDiff = 0;
    a.strategy.forEach((arr, i) => arr.forEach((v, k) => (maxDiff = Math.max(maxDiff, Math.abs(v - b2.strategy[i][k])))));
    a.evChip.forEach((arr, i) => arr.forEach((v, k) => { if (!Number.isNaN(v)) evDiff = Math.max(evDiff, Math.abs(v - b2.evChip[i][k])); }));
    expect(maxDiff).toBeLessThan(1e-4);
    expect(evDiff).toBeLessThan(1e-3);
    expect(b2.exploitability).toBeCloseTo(a.exploitability, 4);
  }, 120_000);
});
