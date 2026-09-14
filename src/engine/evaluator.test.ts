import { describe, expect, it } from 'vitest';
import { evaluate7 } from './evaluator';
import { classCombos, classLabel, COMBOS, COMPAT, compatMul, NUM_CLASSES } from './cards';

const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';
const card = (s: string) => RANKS.indexOf(s[0]) * 4 + SUITS.indexOf(s[1]);
const hand = (s: string) => s.split(' ').map(card);
const ev = (s: string) => evaluate7(hand(s));

describe('evaluate7', () => {
  it('orders categories', () => {
    const order = [
      '2c 7d 9h Js Kc 3d 4h', // high card
      '2c 2d 9h Js Kc 3d 4h', // pair
      '2c 2d 9h 9s Kc 3d 4h', // two pair
      '2c 2d 2h Js Kc 3d 4h', // trips
      'Ac 2d 3h 4s 5c 9d Kh', // wheel straight
      '6c 2d 3h 4s 5c 9d Kh', // 6-high straight
      '2h 7h 9h Jh Kc 3d 4h', // flush
      '2c 2d 2h 9s 9c 3d 4h', // full house
      '2c 2d 2h 2s Kc 3d 4h', // quads
      '5h 6h 7h 8h 9h 2c 2d', // straight flush
    ];
    for (let i = 1; i < order.length; i++) expect(ev(order[i])).toBeGreaterThan(ev(order[i - 1]));
  });

  it('breaks ties by kicker', () => {
    expect(ev('Ac Ad Kh 9s 7c 3d 2h')).toBeGreaterThan(ev('Ac Ad Qh 9s 7c 3d 2h'));
    expect(ev('Ac Ad Kh 9s 7c 3d 2h')).toBe(ev('Ah As Kd 9c 7h 3s 2d'));
    // two trips -> full house using second trips as pair
    expect(ev('Ac Ad Ah Ks Kc Kd 2h')).toBeGreaterThan(ev('Ac Ad Ah Qs Qc Qd 2h'));
  });
});

describe('cards', () => {
  it('has 1326 combos in total', () => {
    expect(COMBOS.reduce((a, b) => a + b, 0)).toBe(1326);
    expect(classLabel(0)).toBe('AA');
    expect(classLabel(1)).toBe('AKs');
    expect(classLabel(13)).toBe('AKo');
    expect(classCombos(1)).toHaveLength(4);
  });

  it('full range has mass 1 against any hand', () => {
    for (let h = 0; h < NUM_CLASSES; h++) {
      // COMPAT counts compatible combos, so a per-combo reach of 1 everywhere sums to 1
      let t = 0;
      for (let j = 0; j < NUM_CLASSES; j++) t += COMPAT[h * NUM_CLASSES + j];
      expect(t).toBeCloseTo(1, 10);
    }
  });

  it('compatMul matches COMPAT matrix product', () => {
    const x = new Float64Array(NUM_CLASSES);
    for (let j = 0; j < NUM_CLASSES; j++) x[j] = ((j * 7919) % 101) / 100;
    const fast = new Float64Array(NUM_CLASSES);
    compatMul(x, fast);
    for (let h = 0; h < NUM_CLASSES; h++) {
      let s = 0;
      for (let j = 0; j < NUM_CLASSES; j++) s += COMPAT[h * NUM_CLASSES + j] * x[j];
      expect(fast[h]).toBeCloseTo(s, 12);
    }
  });
});
