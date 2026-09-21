import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type SolverConfig } from '../engine/config';
import { NUM_CLASSES } from '../engine/cards';
import type { SolveResult } from '../engine/solver';
import type { Action } from '../engine/tree';
import type { LightDecision, LightNode, LightTerminal, LightTree } from '../worker/protocol';
import { enumerateSituations } from './situations';

const N = NUM_CLASSES;

function dec(id: number, player: number, dIndex: number, actions: Action[]): LightDecision {
  return {
    kind: 'decision', id, parent: -1, parentAction: -1, pot: 1.5,
    contrib: [0, 0], behind: [25, 25], folded: [false, false], allin: [false, false],
    player, bet: 1, actions, dIndex,
  };
}

function term(id: number): LightTerminal {
  return {
    kind: 'terminal', id, parent: -1, parentAction: -1, pot: 1.5,
    contrib: [0, 0], behind: [25, 25], folded: [false, false], allin: [false, false],
    tType: 'fold', participants: [0],
  };
}

/**
 * 히어로(좌석 0)가 세 번 행동할 수 있는 2인 트리.
 *   0: 히어로   Fold -> 9 | Raise 2 -> 1
 *   1: 상대     Fold -> 9 | Call 2 -> 9 | Raise 6 -> 2
 *   2: 히어로   Fold -> 9 | All-in 25 -> 3
 *   3: 상대     Fold -> 9 | Call 25 -> 4
 *   4: 히어로   Fold -> 9 | Call 25 -> 9      (히어로 3번째 결정: 목록에서 빠져야 한다)
 */
function buildTree(config: SolverConfig): LightTree {
  const nodes: LightNode[] = [
    dec(0, 0, 0, [{ type: 'fold', to: 0, child: 9 }, { type: 'raise', to: 2, child: 1 }]),
    dec(1, 1, 1, [{ type: 'fold', to: 0, child: 9 }, { type: 'call', to: 2, child: 9 }, { type: 'raise', to: 6, child: 2 }]),
    dec(2, 0, 2, [{ type: 'fold', to: 0, child: 9 }, { type: 'allin', to: 25, child: 3 }]),
    dec(3, 1, 3, [{ type: 'fold', to: 0, child: 9 }, { type: 'call', to: 25, child: 4 }]),
    dec(4, 0, 4, [{ type: 'fold', to: 0, child: 9 }, { type: 'call', to: 25, child: 9 }]),
    term(5), term(6), term(7), term(8), term(9),
  ];
  return { numPlayers: 2, seatNames: ['SB', 'BB'], nodes, numDecisions: 5, startIcm: [50, 50], config };
}

/** 노드별 액션 빈도와 EV를 그대로 받아 SolveResult를 만든다 (모든 클래스에 같은 값). */
function buildResult(freqByNode: number[][], evByNode: number[][]): SolveResult {
  const offsets = new Int32Array(freqByNode.length);
  let total = 0;
  freqByNode.forEach((f, d) => { offsets[d] = total; total += f.length * N; });
  const strategy = new Float32Array(total);
  const evIcm = new Float32Array(total);
  const evChip = new Float32Array(total);
  freqByNode.forEach((f, d) => {
    for (let a = 0; a < f.length; a++) {
      for (let h = 0; h < N; h++) {
        strategy[offsets[d] + a * N + h] = f[a];
        evIcm[offsets[d] + a * N + h] = evByNode[d][a];
        evChip[offsets[d] + a * N + h] = evByNode[d][a];
      }
    }
  });
  return { offsets, strategy, evIcm, evChip, rootIcm: [0, 0], rootChip: [0, 0], exploitability: 0, iterations: 400 };
}

const config = (over: Partial<SolverConfig> = {}): SolverConfig =>
  ({ ...DEFAULT_CONFIG, stacks: [25, 25], payouts: [60, 40], mode: 'chip', smoothing: 0.15, ...over });

/** 모든 노드에서 액션이 고르게 갈리고, EV는 뒤쪽 액션이 확실히 높은 기본 세트. */
function defaults() {
  return {
    freq: [[0.5, 0.5], [0.4, 0.3, 0.3], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5]],
    ev: [[-1, 1], [-1, 0, 1], [-1, 1], [-1, 1], [-1, 1]],
  };
}

describe('enumerateSituations', () => {
  it('히어로가 세 번째로 행동하는 노드는 목록에 넣지 않는다', () => {
    const { freq, ev } = defaults();
    const out = enumerateSituations(buildTree(config()), buildResult(freq, ev), 0, 0);
    const ids = out.map((s) => s.node.id);
    expect(ids).toContain(0);
    expect(ids).toContain(2);
    expect(ids).not.toContain(4);
  });

  it('도달 확률이 임계값 미만인 라인은 제외한다', () => {
    const { freq, ev } = defaults();
    freq[1] = [0.999, 0.0005, 0.0005]; // 상대가 거의 항상 폴드 -> 노드 2에 도달하지 못함
    const out = enumerateSituations(buildTree(config()), buildResult(freq, ev), 0, 0);
    expect(out.map((s) => s.node.id)).toEqual([0]);
  });

  it('첫 결정의 도달 확률은 1이고 깊이는 0이다', () => {
    const { freq, ev } = defaults();
    const out = enumerateSituations(buildTree(config()), buildResult(freq, ev), 0, 0);
    const first = out.find((s) => s.node.id === 0)!;
    expect(first.reach).toBeCloseTo(1, 9);
    expect(first.depth).toBe(0);
    expect(first.path).toEqual([]);
    expect(first.label).toBe('첫 액션');
  });

  it('경로 라벨에 내 액션과 상대 액션을 순서대로 담는다', () => {
    const { freq, ev } = defaults();
    const out = enumerateSituations(buildTree(config()), buildResult(freq, ev), 0, 0);
    const second = out.find((s) => s.node.id === 2)!;
    expect(second.depth).toBe(1);
    expect(second.path).toEqual([1, 2]);
    expect(second.label).toBe('내 Raise 2 → BB Raise 6');
  });

  it('주 단위 EV가 가장 높은 액션을 best로 고른다', () => {
    const { freq, ev } = defaults();
    const out = enumerateSituations(buildTree(config()), buildResult(freq, ev), 0, 0);
    const first = out.find((s) => s.node.id === 0)!;
    expect(first.best).toBe(1);
    expect(first.second).toBe(0);
    expect(first.gap).toBeCloseTo(2, 9);
    expect(first.mixed).toBe(false);
  });

  it('EV 차이가 smoothing 이내이면 혼합으로 판정한다', () => {
    const { freq, ev } = defaults();
    ev[0] = [0.0, 0.05]; // 0.05bb 차이 < smoothing 0.15bb
    const out = enumerateSituations(buildTree(config()), buildResult(freq, ev), 0, 0);
    const first = out.find((s) => s.node.id === 0)!;
    // SolveResult는 float32로 저장하므로 0.05가 정확히 되살아나지 않는다 (정밀도를 9로 올리지 말 것)
    expect(first.gap).toBeCloseTo(0.05, 6);
    expect(first.mixed).toBe(true);
  });

  it('ICM 모드에서는 EV를 evIcm으로 읽는다', () => {
    const { freq, ev } = defaults();
    const res = buildResult(freq, ev);
    // ICM 배열만 순서를 뒤집어, 어느 배열을 읽는지 구분한다
    for (let i = 0; i < res.evIcm.length; i++) res.evIcm[i] = -res.evChip[i];
    const out = enumerateSituations(buildTree(config({ mode: 'icm' })), res, 0, 0);
    const first = out.find((s) => s.node.id === 0)!;
    expect(first.best).toBe(0);
  });

  it('깊이 다음으로 도달 확률 내림차순으로 정렬한다', () => {
    const { freq, ev } = defaults();
    const out = enumerateSituations(buildTree(config()), buildResult(freq, ev), 0, 0);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].depth).toBeGreaterThanOrEqual(out[i - 1].depth);
      if (out[i].depth === out[i - 1].depth) expect(out[i].reach).toBeLessThanOrEqual(out[i - 1].reach);
    }
  });

  it('선택한 핸드의 빈도로 히어로 자신의 앞선 액션을 가중한다', () => {
    const { freq, ev } = defaults();
    const res = buildResult(freq, ev);
    // 클래스 5에서만 히어로가 루트에서 Raise를 20%만 쓴다
    res.strategy[res.offsets[0] + 0 * N + 5] = 0.8;
    res.strategy[res.offsets[0] + 1 * N + 5] = 0.2;
    const out = enumerateSituations(buildTree(config()), res, 0, 5);
    const second = out.find((s) => s.node.id === 2)!;
    // SolveResult는 float32로 저장하므로 0.2 × 0.3이 정확히 되살아나지 않는다 (정밀도를 9로 올리지 말 것)
    expect(second.reach).toBeCloseTo(0.2 * 0.3, 6); // 내 레이즈 0.2 × 상대 3벳 0.3
  });
});
