import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type SolverConfig } from '../engine/config';
import { buildTree, type TerminalNode } from '../engine/tree';
import type { LightTerminal, LightTree } from '../worker/protocol';
import { showdownUtilities } from './coachinput';

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
