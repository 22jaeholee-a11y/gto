import { describe, expect, it } from 'vitest';
import { NUM_CLASSES } from '../engine/cards';
import { DEFAULT_CONFIG, type SolverConfig } from '../engine/config';
import { playerTemperatures, type SolveResult } from '../engine/solver';
import { buildTree, type TerminalNode } from '../engine/tree';
import type { LightDecision, LightTerminal, LightTree } from '../worker/protocol';
import { buildPreflopCoachInput, requiredEquity, showdownUtilities } from './coachinput';
import type { TrailStep } from './spot';

/** 엔진 트리를 워커가 보내는 모양으로 깎는다 (utilIcm 등 제거). */
function lighten(tree: ReturnType<typeof buildTree>): LightTree {
  return {
    numPlayers: tree.numPlayers,
    seatNames: tree.seatNames,
    numDecisions: tree.numDecisions,
    startIcm: tree.startIcm,
    config: tree.config,
    nodes: tree.nodes.map((nd) => {
      if (nd.kind === 'decision') return nd;
      const { utilIcm, utilChip, outcomes, eqr, playScale, ...rest } = nd;
      void utilIcm; void utilChip; void outcomes; void eqr; void playScale;
      return rest as LightTerminal;
    }),
  };
}

const cfg = (over: Partial<SolverConfig> = {}): SolverConfig =>
  ({ ...DEFAULT_CONFIG, stacks: [10, 12, 8], payouts: [50, 30, 20], ante: 1, pushFoldOnly: true, mode: 'icm', ...over });

/**
 * 실제로 솔브하지 않고 균등 전략을 쓰는 가짜 SolveResult를 만든다.
 * offsets 레이아웃은 솔버(src/engine/solver.ts)가 만드는 방식과 같다: dIndex 순서로
 * 액션 수 * 169개씩 잘라 붙인다. evAt으로 각 (dIndex, action, hand)의 EV를 지정할 수 있다.
 */
function fakeResult(
  tree: LightTree,
  evAt: (dIndex: number, action: number, hand: number) => { icm: number; chip: number } = () => ({ icm: 0, chip: 0 }),
): SolveResult {
  const decisions = tree.nodes.filter((nd): nd is LightDecision => nd.kind === 'decision');
  const offsets = new Int32Array(tree.numDecisions).fill(-1);
  let off = 0;
  for (const nd of decisions) {
    offsets[nd.dIndex] = off;
    off += nd.actions.length * NUM_CLASSES;
  }
  const strategy = new Float32Array(off);
  const evIcm = new Float32Array(off);
  const evChip = new Float32Array(off);
  for (const nd of decisions) {
    const o = offsets[nd.dIndex];
    const A = nd.actions.length;
    for (let a = 0; a < A; a++) {
      for (let h = 0; h < NUM_CLASSES; h++) {
        strategy[o + a * NUM_CLASSES + h] = 1 / A;
        const e = evAt(nd.dIndex, a, h);
        evIcm[o + a * NUM_CLASSES + h] = e.icm;
        evChip[o + a * NUM_CLASSES + h] = e.chip;
      }
    }
  }
  return { offsets, strategy, evIcm, evChip, rootIcm: [], rootChip: [], exploitability: 0, iterations: 0 };
}

describe('showdownUtilities', () => {
  it('헤즈업 올인 쇼다운의 승·패 값을 엔진과 같게 재구성한다', () => {
    const full = buildTree(cfg());
    const light = lighten(full);
    const showdowns = full.nodes.filter(
      (nd): nd is TerminalNode => nd.kind === 'terminal' && nd.tType === 'showdown' && nd.participants.length === 2,
    );
    expect(showdowns.length).toBeGreaterThan(0);

    for (const t of showdowns) {
      const hero = t.participants[0];
      const n = full.numPlayers;
      const oWin = t.outcomes.findIndex((o) => o[0] === hero);
      const oLose = 1 - oWin;
      const got = showdownUtilities(light, light.nodes[t.id] as LightTerminal, hero)!;
      expect(got.winIcm).toBeCloseTo(t.utilIcm[oWin * n + hero], 9);
      expect(got.loseIcm).toBeCloseTo(t.utilIcm[oLose * n + hero], 9);
      expect(got.winChip).toBeCloseTo(t.utilChip[oWin * n + hero], 9);
      expect(got.loseChip).toBeCloseTo(t.utilChip[oLose * n + hero], 9);
    }
  });

  it('참가자가 2명이 아니거나 쇼다운이 아니면 null을 준다', () => {
    const full = buildTree(cfg());
    const light = lighten(full);
    const fold = full.nodes.find((nd) => nd.kind === 'terminal' && nd.tType === 'fold')!;
    expect(showdownUtilities(light, light.nodes[fold.id] as LightTerminal, 0)).toBeNull();
  });
});

// 3인 push/fold 트리 고정 구조 (scratch로 확인):
// id0(BTN, fold/allin) -[allin]-> id6(SB, fold/call/allin) -[call]-> id10(BB, fold/call) -[fold]-> id11(showdown [SB,BTN])
describe('requiredEquity', () => {
  it('call이나 fold 액션이 없는 노드는 { chip: null, icm: null }을 준다', () => {
    const full = buildTree(cfg());
    const light = lighten(full);
    const root = light.nodes[0] as LightDecision; // fold, allin만 있고 call은 없다
    expect(root.actions.some((a) => a.type === 'call')).toBe(false);
    const result = fakeResult(light);
    expect(requiredEquity(light, result, root, 0, root.player)).toEqual({ chip: null, icm: null });
  });

  it('콜이 폴드를 거쳐 헤즈업 올인으로 이어지면 (foldEV-lose)/(win-lose)를 돌려준다', () => {
    const full = buildTree(cfg());
    const light = lighten(full);
    const node = light.nodes[6] as LightDecision; // SB, BTN 올인에 대한 결정
    const terminal = light.nodes[11] as LightTerminal; // call -> (BB fold) -> [SB, BTN] 쇼다운
    const hero = 1;
    const hand = 0;
    const foldIdx = node.actions.findIndex((a) => a.type === 'fold');
    const u = showdownUtilities(light, terminal, hero)!;
    expect(u).not.toBeNull();
    // fold EV를 승/패의 정확히 중간으로 둬서 필요 에퀴티가 0.5가 되게 한다.
    const fI = (u.winIcm + u.loseIcm) / 2;
    const fC = (u.winChip + u.loseChip) / 2;
    const result = fakeResult(light, (dIndex, action, h) => {
      if (dIndex === node.dIndex && action === foldIdx && h === hand) return { icm: fI, chip: fC };
      return { icm: 0, chip: 0 };
    });
    const got = requiredEquity(light, result, node, hand, hero);
    // evIcm/evChip은 Float32Array라 fI/fC 저장 시 정밀도가 float64보다 낮다.
    expect(got.icm).toBeCloseTo(0.5, 6);
    expect(got.chip).toBeCloseTo(0.5, 6);
  });

  it('foldEV가 패배 값보다 낮으면 0으로, 승리 값보다 높으면 1로 클램프한다', () => {
    const full = buildTree(cfg());
    const light = lighten(full);
    const node = light.nodes[6] as LightDecision;
    const terminal = light.nodes[11] as LightTerminal;
    const hero = 1;
    const hand = 0;
    const foldIdx = node.actions.findIndex((a) => a.type === 'fold');
    const u = showdownUtilities(light, terminal, hero)!;

    const below = fakeResult(light, (dIndex, action, h) => {
      if (dIndex === node.dIndex && action === foldIdx && h === hand) return { icm: u.loseIcm - 5, chip: u.loseChip - 5 };
      return { icm: 0, chip: 0 };
    });
    const gotBelow = requiredEquity(light, below, node, hand, hero);
    expect(gotBelow.icm).toBe(0);
    expect(gotBelow.chip).toBe(0);

    const above = fakeResult(light, (dIndex, action, h) => {
      if (dIndex === node.dIndex && action === foldIdx && h === hand) return { icm: u.winIcm + 5, chip: u.winChip + 5 };
      return { icm: 0, chip: 0 };
    });
    const gotAbove = requiredEquity(light, above, node, hand, hero);
    expect(gotAbove.icm).toBe(1);
    expect(gotAbove.chip).toBe(1);
  });
});

describe('buildPreflopCoachInput', () => {
  it('루트에서는 aggressor가 없고 heroOpenShare·playersLeft·배열 길이가 맞다', () => {
    const full = buildTree(cfg());
    const light = lighten(full);
    const node = light.nodes[0] as LightDecision; // BTN, fold(균등 50%)/allin(균등 50%)
    const hand = 0;
    const result = fakeResult(light);
    const input = buildPreflopCoachInput(light, result, [], node, hand, 0, 1);
    expect(input.aggressor).toBeNull();
    // 균등 전략이라 fold/allin 각 50%; raise/allin만 더하면 allin의 50%만 남는다.
    expect(input.heroOpenShare).toBeCloseTo(0.5, 9);
    expect(input.playersLeft).toBe(2); // BTN 다음 SB, BB 둘 다 아직 살아있다
    expect(input.labels.length).toBe(node.actions.length);
    expect(input.kinds.length).toBe(node.actions.length);
    expect(input.freq.length).toBe(node.actions.length);
    expect(input.evIcm.length).toBe(node.actions.length);
    expect(input.evChip.length).toBe(node.actions.length);
  });

  it('레이즈 이후 노드에서는 aggressor·villainReach가 채워지고 heroOpenShare는 null이다', () => {
    const full = buildTree(cfg());
    const light = lighten(full);
    const root = light.nodes[0] as LightDecision;
    const node = light.nodes[6] as LightDecision; // BTN 올인 이후 SB의 결정
    const hand = 0;
    const allinIdx = root.actions.findIndex((a) => a.type === 'allin');
    const trail: TrailStep[] = [{ node: root, action: allinIdx }];
    const result = fakeResult(light);
    const input = buildPreflopCoachInput(light, result, trail, node, hand, 0, 1);
    expect(input.aggressor).toBe(root.player);
    expect(input.villainReach).not.toBeNull();
    expect(input.heroOpenShare).toBeNull();
    expect(input.playersLeft).toBe(1); // SB 다음 BB만 아직 살아있다
  });

  it('lossBB는 chip 모드에서 loss와 같고, icm 모드에서는 playerTemperatures로 나눈 값과 같다', () => {
    const chipTree = lighten(buildTree(cfg({ mode: 'chip' })));
    const chipNode = chipTree.nodes[0] as LightDecision;
    const hand = 0;
    const chosen = 0;
    const best = 1;
    const chipResult = fakeResult(chipTree, (dIndex, action, h) => {
      if (dIndex === chipNode.dIndex && h === hand) {
        if (action === chosen) return { icm: 0, chip: 2 };
        if (action === best) return { icm: 0, chip: 9 };
      }
      return { icm: 0, chip: 0 };
    });
    const chipInput = buildPreflopCoachInput(chipTree, chipResult, [], chipNode, hand, chosen, best);
    expect(chipInput.loss).toBeCloseTo(7, 9);
    expect(chipInput.lossBB).toBeCloseTo(chipInput.loss, 9);

    const icmTree = lighten(buildTree(cfg({ mode: 'icm' })));
    const icmNode = icmTree.nodes[0] as LightDecision;
    const icmResult = fakeResult(icmTree, (dIndex, action, h) => {
      if (dIndex === icmNode.dIndex && h === hand) {
        if (action === chosen) return { icm: 1, chip: 0 };
        if (action === best) return { icm: 8, chip: 0 };
      }
      return { icm: 0, chip: 0 };
    });
    const icmInput = buildPreflopCoachInput(icmTree, icmResult, [], icmNode, hand, chosen, best);
    expect(icmInput.loss).toBeCloseTo(7, 9);
    const expectedLossBB = icmInput.loss / playerTemperatures(icmTree, 1, 'icm')[icmNode.player];
    expect(icmInput.lossBB).toBeCloseTo(expectedLossBB, 9);
  });
});
