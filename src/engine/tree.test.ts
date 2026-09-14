import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type SolverConfig } from './config';
import { buildTree, distributeSidePots, type TerminalNode } from './tree';

const cfg = (over: Partial<SolverConfig>): SolverConfig => ({ ...DEFAULT_CONFIG, ...over });

describe('distributeSidePots', () => {
  it('splits main and side pot', () => {
    // seat0 all-in 5, seat1 and seat2 put 20; seat2 best, seat0 second
    const win = distributeSidePots([5, 20, 20], [false, false, false], 1, [0, 2, 1]);
    expect(win[0]).toBe(16); // 5*3 + 1 ante
    expect(win[2]).toBe(30);
    expect(win[1]).toBe(0);
  });
  it('returns uncalled chips to the bigger stack', () => {
    const win = distributeSidePots([10, 25], [false, false], 0, [0, 1]);
    expect(win[0]).toBe(20);
    expect(win[1]).toBe(15);
  });
});

describe('buildTree', () => {
  it('heads-up push/fold tree has the expected shape', () => {
    const t = buildTree(cfg({ stacks: [10, 10], ante: 0, pushFoldOnly: true, payouts: [1] }));
    const root = t.nodes[0];
    expect(root.kind).toBe('decision');
    if (root.kind !== 'decision') return;
    expect(root.player).toBe(0);
    expect(root.actions.map((a) => a.type)).toEqual(['fold', 'allin']);
    const shove = t.nodes[root.actions[1].child];
    expect(shove.kind).toBe('decision');
    if (shove.kind !== 'decision') return;
    expect(shove.actions.map((a) => a.type)).toEqual(['fold', 'call']);
    const sd = t.nodes[shove.actions[1].child] as TerminalNode;
    expect(sd.tType).toBe('showdown');
    expect(sd.outcomes).toHaveLength(2);
    // chip utils: SB wins +10
    const o = sd.outcomes.findIndex((ord) => ord[0] === 0);
    expect(sd.utilChip[o * 2 + 0]).toBeCloseTo(10);
    expect(sd.utilChip[o * 2 + 1]).toBeCloseTo(-10);
    // ICM utils in % pool, zero-sum across seats
    expect(sd.utilIcm[o * 2] + sd.utilIcm[o * 2 + 1]).toBeCloseTo(0);
  });

  it('8-max tree never builds 4+ way all-ins or 5-way pots', () => {
    const t = buildTree(cfg({}));
    let maxFlop = 0;
    for (const nd of t.nodes) {
      if (nd.kind !== 'terminal') continue;
      if (nd.tType === 'showdown') expect(nd.participants.length).toBeLessThanOrEqual(3);
      if (nd.tType === 'flop') maxFlop = Math.max(maxFlop, nd.participants.length);
      // ICM utilities are zero-sum over all seats per outcome
      for (let o = 0; o < nd.outcomes.length; o++) {
        let s = 0, c = 0;
        for (let j = 0; j < t.numPlayers; j++) { s += nd.utilIcm[o * t.numPlayers + j]; c += nd.utilChip[o * t.numPlayers + j]; }
        expect(Math.abs(s)).toBeLessThan(1e-6);
        expect(Math.abs(c)).toBeLessThan(1e-6);
      }
    }
    expect(maxFlop).toBeLessThanOrEqual(4);
    console.log(`8-max 25bb nodes=${t.nodes.length} decisions=${t.numDecisions}`);
  });
});
