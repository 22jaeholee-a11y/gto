import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type SolverConfig } from '../config';
import { NUM_CLASSES } from '../cards';
import { CLASS_COMBOS, COMBO_CLASS, NC } from './combos';
import { anteBySeat, classToComboWeights, normalizedPayouts, preflopExit } from './spot';

const cfg = (over: Partial<SolverConfig> = {}): SolverConfig => ({ ...DEFAULT_CONFIG, ...over });

describe('classToComboWeights', () => {
  it('클래스 가중치를 그 클래스의 모든 콤보에 그대로 펼친다', () => {
    const reach = new Float64Array(NUM_CLASSES);
    reach[0] = 0.25; // AA
    reach[1] = 0.5; // AKs
    const w = classToComboWeights(reach);
    expect(w.length).toBe(NC);
    for (const k of CLASS_COMBOS[0]) expect(w[k]).toBe(0.25);
    for (const k of CLASS_COMBOS[1]) expect(w[k]).toBe(0.5);
    let others = 0;
    for (let k = 0; k < NC; k++) if (COMBO_CLASS[k] > 1) others += w[k];
    expect(others).toBe(0);
  });
});

describe('anteBySeat', () => {
  it('BB 좌석만 앤티를 내고 스택으로 상한이 걸린다', () => {
    expect(anteBySeat(cfg({ stacks: [25, 25, 25], ante: 1 }))).toEqual([0, 0, 1]);
    expect(anteBySeat(cfg({ stacks: [25, 25, 0.4], ante: 1 }))).toEqual([0, 0, 0.4]);
  });
});

describe('normalizedPayouts', () => {
  it('상금을 합이 1이 되게 정규화한다', () => {
    const p = normalizedPayouts(cfg({ payouts: [30, 20, 10] }));
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(p[0]).toBeCloseTo(0.5, 12);
    expect(p[1]).toBeCloseTo(1 / 3, 12);
    expect(p[2]).toBeCloseTo(1 / 6, 12);
  });
});

describe('preflopExit', () => {
  const base8 = cfg({ stacks: [25, 25, 25, 25, 25, 25, 25, 25], ante: 1, payouts: [30, 20, 14, 10, 8, 7, 6, 5], mode: 'icm' });
  const reachBySeat = () => {
    const r: Float64Array[] = [];
    for (let s = 0; s < 8; s++) {
      const a = new Float64Array(NUM_CLASSES);
      a.fill(s === 4 ? 0.2 : 0.7);
      r.push(a);
    }
    return r;
  };

  it('OOP(먼저 행동하는 좌석)를 앞에 두고 좌석을 정렬한다', () => {
    // 8인 테이블: CO = 4 (postflopRank 6), BB = 7 (postflopRank 1) -> BB가 OOP
    const exit = preflopExit({
      config: base8,
      participants: [4, 7],
      pot: 5,
      contrib: [0, 0, 0, 0, 2, 0, 0.5, 2],
      reachBySeat: reachBySeat(),
    });
    expect(exit.seats).toEqual([7, 4]);
    expect(exit.icm.seats).toEqual([7, 4]);
  });

  it('앤티와 프리플랍 투입액을 뺀 남은 스택을 계산한다', () => {
    const exit = preflopExit({
      config: base8,
      participants: [4, 7],
      pot: 5,
      contrib: [0, 0, 0, 0, 2, 0, 0.5, 2],
      reachBySeat: reachBySeat(),
    });
    expect(exit.base[7]).toBeCloseTo(22, 9); // 25 - 앤티 1 - 투입 2
    expect(exit.base[4]).toBeCloseTo(23, 9);
    expect(exit.base[6]).toBeCloseTo(24.5, 9);
    expect(exit.icm.baseStacks).toEqual(exit.base);
  });

  it('레인지를 OOP·IP 순서로 콤보 가중치로 펼친다', () => {
    const exit = preflopExit({
      config: base8,
      participants: [4, 7],
      pot: 5,
      contrib: [0, 0, 0, 0, 2, 0, 0.5, 2],
      reachBySeat: reachBySeat(),
    });
    expect(exit.ranges[0][0]).toBeCloseTo(0.7, 9); // BB
    expect(exit.ranges[1][0]).toBeCloseTo(0.2, 9); // CO
  });

  it('ICM 컨텍스트에 모드·정규화 상금·시작 스택을 담는다', () => {
    const exit = preflopExit({
      config: base8,
      participants: [4, 7],
      pot: 5,
      contrib: [0, 0, 0, 0, 2, 0, 0.5, 2],
      reachBySeat: reachBySeat(),
    });
    expect(exit.icm.mode).toBe('icm');
    expect(exit.icm.payouts.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(exit.icm.startStacks).toEqual(base8.stacks);
  });

  it('참가자가 2명이 아니면 거부한다', () => {
    expect(() => preflopExit({
      config: base8,
      participants: [4, 6, 7],
      pot: 6,
      contrib: [0, 0, 0, 0, 2, 0, 2, 2],
      reachBySeat: reachBySeat(),
    })).toThrow();
  });
});
