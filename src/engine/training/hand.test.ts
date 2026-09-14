import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config';
import { finalize, Solver } from '../solver';
import { buildTree } from '../tree';
import { PostflopSolver } from '../postflop/solver';
import { buildPostflopTree } from '../postflop/tree';
import { mulberry32, type Scenario } from './scenario';
import { TrainingHand, type PostflopService, type SolvedScenario } from './hand';

const service: PostflopService = {
  async solve(spot, ranges, onProgress) {
    await new Promise((r) => setTimeout(r, 0));
    const tree = buildPostflopTree(spot);
    const solver = new PostflopSolver(tree, ranges);
    const iters = spot.street === 'turn' ? 15 : 40;
    solver.run(iters);
    onProgress?.(1);
    return solver.finalize();
  },
};

function solvedScenario(stacks: number[], payouts: number[]): SolvedScenario {
  const config = { ...DEFAULT_CONFIG, stacks, payouts, iterations: 120 };
  const tree = buildTree(config);
  const s = new Solver(tree);
  s.run(120);
  const scenario: Scenario = { id: 'test', label: 'test', config, createdAt: 0 };
  return { scenario, tree, result: finalize(s) };
}

describe('TrainingHand', () => {
  it('plays complete hands through every street with consistent chips', async () => {
    const sc = solvedScenario([12, 18, 15], [50, 30, 20]);
    const rand = mulberry32(7);
    let postflopHands = 0, reviews = 0, showdowns = 0, rangeReviews = 0;
    for (let h = 0; h < 16; h++) {
      const hand = new TrainingHand(sc, rand, service, h % 3);
      await hand.begin();
      for (let guard = 0; guard < 30 && hand.view.status === 'hero'; guard++) {
        const opts = hand.view.pending!.options;
        // prefer continuing so postflop streets get exercised
        const nonFold = opts.map((o, i) => [o, i] as const).filter(([o]) => !o.startsWith('Fold'));
        const pick = nonFold.length && rand() < 0.85 ? nonFold[Math.floor(rand() * nonFold.length)][1] : Math.floor(rand() * opts.length);
        await hand.act(pick);
      }
      const v = hand.view;
      expect(v.status).toBe('done');
      expect(v.result).not.toBeNull();
      if (v.board.length >= 3) postflopHands++;
      if (v.result!.shown.length) showdowns++;
      reviews += v.log.filter((e) => e.review).length;
      for (const e of v.log) if (e.review && e.review.verdict !== 'info') expect(Number.isFinite(e.review.loss)).toBe(true);
      for (const e of v.log) {
        const r = e.review?.range;
        if (!e.review || e.review.verdict === 'info') continue;
        expect(r).toBeDefined();
        const freqSum = r!.summary.reduce((acc, x) => acc + x.freq, 0);
        expect(freqSum).toBeCloseTo(1, 3);
        expect(r!.weight[r!.heroClass]).toBeGreaterThan(0);
        const A = r!.actions.length;
        for (let c = 0; c < 169; c++) {
          if (r!.weight[c] < 1e-6) continue;
          let sum = 0;
          for (let x = 0; x < A; x++) sum += r!.freq[c * A + x];
          expect(sum).toBeCloseTo(1, 3);
        }
        if (r!.valueChip !== null) expect(Number.isFinite(r!.valueChip)).toBe(true);
        rangeReviews++;
      }
      if (!v.result!.text.startsWith('히어로 폴드')) {
        const total = v.stacks.reduce((a, b) => a + b, 0);
        expect(total).toBeCloseTo(12 + 18 + 15, 6);
      }
    }
    console.log(`hands with a flop ${postflopHands}/16, showdowns ${showdowns}, hero reviews ${reviews}`);
    expect(postflopHands).toBeGreaterThan(3);
    expect(reviews).toBeGreaterThan(15);
    expect(rangeReviews).toBeGreaterThan(10);
  }, 300_000);
});
