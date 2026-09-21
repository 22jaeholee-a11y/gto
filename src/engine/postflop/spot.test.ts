import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type SolverConfig } from '../config';
import { NUM_CLASSES } from '../cards';
import { buildTree, postflopRank, type TerminalNode } from '../tree';
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

// design §6: "같은 프리플랍 스팟에서 preflopExit가 hand.ts의 헤즈업 진입과 같은
// 스팟·레인지·ICM 컨텍스트를 만든다" — hand.ts의 finalsAfterPreflop은 이 파일의
// preflopExit와 별개로 `stacks - ante - contrib` 식을 다시 계산하므로, 실제 트리에서
// 뽑은 헤즈업 플랍 종료 노드로 그 식과 seats·pot·icm 컨텍스트가 어긋나지 않는지 고정한다.
describe('preflopExit ↔ hand.ts 헤즈업 진입 패리티', () => {
  it('실제 트리의 헤즈업 플랍 종료 노드에서 base·seats·pot·icm이 hand.ts 공식과 일치한다', () => {
    const config = DEFAULT_CONFIG;
    const tree = buildTree(config);
    const terminal = tree.nodes.find(
      (nd): nd is TerminalNode => nd.kind === 'terminal' && nd.tType === 'flop' && nd.participants.length === 2,
    );
    expect(terminal).toBeDefined();
    const t = terminal!;

    // hand.ts의 finalsAfterPreflop(base = stacks - ante - contrib)을 여기서 독립적으로 계산한다
    const ante = anteBySeat(config);
    const expectedBase = config.stacks.map((s, j) => s - ante[j] - t.contrib[j]);

    const reachBySeat: Float64Array[] = config.stacks.map(() => {
      const a = new Float64Array(NUM_CLASSES);
      a.fill(0.5);
      return a;
    });
    const exit = preflopExit({ config, participants: t.participants, pot: t.pot, contrib: t.contrib, reachBySeat });

    // seats: hand.ts가 preflopTerminal에서 postflopRank로 정렬해 넘기는 것과 같은 순서
    const orderedSeats = t.participants
      .slice()
      .sort((a, b) => postflopRank(a, config.stacks.length) - postflopRank(b, config.stacks.length));
    expect(exit.seats).toEqual(orderedSeats);

    // base: 참가 좌석은 hand.ts의 독립 계산과 일치해야 한다
    for (const seat of t.participants) expect(exit.base[seat]).toBeCloseTo(expectedBase[seat], 9);

    // pot: 종료 노드의 팟을 그대로 넘겨받는다
    expect(exit.pot).toBe(t.pot);

    // icm 컨텍스트: 트레이닝 경로가 만드는 것과 같은 모드·정규화 상금·시작 스택·baseStacks·seats
    expect(exit.icm.mode).toBe(config.mode);
    expect(exit.icm.payouts).toEqual(normalizedPayouts(config));
    expect(exit.icm.startStacks).toEqual(config.stacks);
    expect(exit.icm.baseStacks).toEqual(exit.base);
    expect(exit.icm.seats).toEqual(orderedSeats);
  });
});
