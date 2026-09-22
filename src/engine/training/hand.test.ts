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

  it('테이블에 체크한 좌석을 표시한다', async () => {
    const sc = solvedScenario([12, 18, 15], [50, 30, 20]);
    const rand = mulberry32(3);
    let seenChecks = 0;
    // 화면에 그려지는 모든 상태에서, checked는 "이번 스트리트의 마지막 로그가 Check인 좌석"과 같아야 한다
    const verify = (hand: TrainingHand) => {
      const v = hand.view;
      if (v.status === 'done') return;
      for (let seat = 0; seat < v.seatNames.length; seat++) {
        const mine = v.log.filter((e) => e.street === v.street && e.seat === seat);
        const last = mine[mine.length - 1];
        const isCheck = !!last && last.text.endsWith('Check');
        expect(v.checked[seat]).toBe(isCheck);
        if (isCheck) seenChecks++;
      }
    };
    for (let h = 0; h < 16; h++) {
      const hand = new TrainingHand(sc, rand, service, h % 3);
      hand.subscribe(() => verify(hand));
      await hand.begin();
      for (let guard = 0; guard < 30 && hand.view.status === 'hero'; guard++) {
        const opts = hand.view.pending!.options;
        // 체크가 있으면 자주 골라 체크 표시를 실제로 만들어낸다
        const check = opts.findIndex((o) => o.startsWith('Check'));
        const nonFold = opts.map((o, i) => [o, i] as const).filter(([o]) => !o.startsWith('Fold'));
        const pick = check >= 0 && rand() < 0.7
          ? check
          : nonFold.length && rand() < 0.85 ? nonFold[Math.floor(rand() * nonFold.length)][1] : Math.floor(rand() * opts.length);
        await hand.act(pick);
      }
      expect(hand.view.status).toBe('done');
      // 핸드가 끝나면 베팅과 마찬가지로 체크 표시도 지운다
      expect(hand.view.checked.every((c) => !c)).toBe(true);
    }
    expect(seenChecks).toBeGreaterThan(0);
  }, 300_000);
});
