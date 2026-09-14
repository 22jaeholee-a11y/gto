import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config';
import { parseCard } from '../postflop/combos';
import { finalize, Solver } from '../solver';
import { buildTree } from '../tree';
import { describeHand } from './handinfo';
import { TrainingHand, type PostflopService } from './hand';
import { mulberry32 } from './scenario';

const cards = (s: string) => s.split(' ').map(parseCard);

describe('describeHand', () => {
  it('names made hands and draws', () => {
    expect(describeHand(cards('Ah Kd') as [number, number], cards('Ks 7c 2d')).made).toMatch(/^탑페어 \(A 키커\)/);
    expect(describeHand(cards('Qh Qd') as [number, number], cards('Js 7c 2d')).made).toMatch(/^오버페어/);
    expect(describeHand(cards('7h 7d') as [number, number], cards('Js 7c 2d')).made).toBe('셋');
    const fd = describeHand(cards('Ah 5h') as [number, number], cards('Kh 9h 2c'));
    expect(fd.draws).toContain('넛 플러시 드로우');
    const oesd = describeHand(cards('9c 8d') as [number, number], cards('7h 6s 2c'));
    expect(oesd.draws).toContain('양방 스트레이트 드로우');
    const wheel = describeHand(cards('Ac 4d') as [number, number], cards('3h 2s Kc'));
    expect(wheel.draws).toContain('거트샷');
  });
});

describe('coach explanations', () => {
  it('explains bubble risk premium when facing a shove', async () => {
    const config = { ...DEFAULT_CONFIG, stacks: [20, 20, 20], ante: 0, pushFoldOnly: true, payouts: [50, 50], iterations: 300 };
    const tree = buildTree(config);
    const solver = new Solver(tree);
    solver.run(300);
    const sc = { scenario: { id: 'b', label: 'bubble', config, createdAt: 0 }, tree, result: finalize(solver) };
    const service: PostflopService = { solve: () => Promise.reject(new Error('no postflop in push/fold')) };
    const rand = mulberry32(3);
    let explained = 0;
    for (let h = 0; h < 300 && explained < 3; h++) {
      const hand = new TrainingHand(sc, rand, service, 2); // BB
      await hand.begin();
      if (hand.view.status !== 'hero') continue;
      const pending = hand.view.pending!;
      if (!pending.options.some((o) => o.startsWith('Call'))) continue;
      await hand.act(0); // fold
      const review = hand.view.log.find((e) => e.review)!.review!;
      const ex = review.explanation!;
      expect(ex.headline.length).toBeGreaterThan(0);
      const text = ex.reasons.join(' ');
      expect(text).toContain('버블');
      expect(ex.tags).toContain('리스크 프리미엄');
      const m = text.match(/칩 기준 ([\d.]+)%, ICM 기준 ([\d.]+)%/);
      expect(m).not.toBeNull();
      expect(Number(m![2])).toBeGreaterThan(Number(m![1]));
      expect(hand.view.result?.summary?.decisions).toBe(1);
      explained++;
    }
    expect(explained).toBe(3);
  }, 120_000);
});
