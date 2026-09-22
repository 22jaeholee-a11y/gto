// 선택한 핸드가 특정 좌석에서 마주치는 프리플랍 상황을 열거한다.
// 화면에 의존하지 않는 순수 함수라서 테스트할 수 있다.

import type { SolveResult } from '../engine/solver';
import { playerTemperatures } from '../engine/solver';
import type { LightDecision, LightTree } from '../worker/protocol';
import { actionTotals, evOf, freqOf, label, playerReach, rareSteps, type TrailStep } from './spot';

/** 히어로가 이 횟수만큼 이미 행동한 경로는 더 내려가지 않는다. */
export const MAX_HERO_DECISIONS = 2;
/** 선택한 핸드 기준 도달 확률이 이 값 미만이면 숨긴다 (희소 라인은 EV가 불안정하다). */
export const MIN_REACH = 0.005;
/** 한 번에 보여주는 최대 행 수. */
export const MAX_ROWS = 40;

export interface SituationOption {
  index: number;
  label: string;
  freq: number;
  evIcm: number;
  evChip: number;
}

export interface Situation {
  /** 루트에서 이 결정 노드까지의 액션 인덱스 */
  path: number[];
  node: LightDecision;
  /** 이 경로에서 히어로가 이미 행동한 횟수 */
  depth: number;
  /** 선택한 핸드를 들고 이 노드에 도달할 확률 */
  reach: number;
  label: string;
  options: SituationOption[];
  /** 주 단위 EV가 가장 높은 액션의 인덱스 */
  best: number;
  /** 2등 액션의 인덱스, 액션이 하나뿐이면 -1 */
  second: number;
  /** best와 second의 EV 차이 (주 단위) */
  gap: number;
  /** 차이가 솔버의 smoothing 온도 이내라 사실상 동등한가 */
  mixed: boolean;
  /** 경로에 균형 전략이 거의 쓰지 않는 액션이 있는가 */
  rare: boolean;
}

function num(x: number): number {
  return Number.isFinite(x) ? x : -Infinity;
}

/** 경로를 한 줄로 압축한다. 폴드는 생략하고 마지막에 한 번만 알린다. */
export function pathLabel(tree: LightTree, trail: TrailStep[], hero: number): string {
  const parts: string[] = [];
  let folded = false;
  for (const { node, action } of trail) {
    const a = node.actions[action];
    if (a.type === 'fold') { folded = true; continue; }
    const name = node.player === hero ? '내' : tree.seatNames[node.player];
    parts.push(`${name} ${label(a, node)}`);
  }
  if (parts.length === 0) return folded ? '첫 액션 · 나머지 폴드' : '첫 액션';
  return parts.join(' → ') + (folded ? ' · 나머지 폴드' : '');
}

function buildSituation(
  tree: LightTree, result: SolveResult, node: LightDecision,
  path: number[], trail: TrailStep[], depth: number, reach: number,
  hand: number, hero: number, tau: number,
): Situation {
  const options: SituationOption[] = node.actions.map((a, i) => ({
    index: i,
    label: label(a, node),
    freq: freqOf(result, node, i, hand),
    evIcm: evOf(result.evIcm, result, node, i, hand),
    evChip: evOf(result.evChip, result, node, i, hand),
  }));
  const key = tree.config.mode === 'icm' ? 'evIcm' : 'evChip';
  let best = 0;
  for (let i = 1; i < options.length; i++) if (num(options[i][key]) > num(options[best][key])) best = i;
  let second = -1;
  for (let i = 0; i < options.length; i++) {
    if (i === best) continue;
    if (second < 0 || num(options[i][key]) > num(options[second][key])) second = i;
  }
  const gap = second >= 0 ? num(options[best][key]) - num(options[second][key]) : 0;
  return {
    path, node, depth, reach,
    label: pathLabel(tree, trail, hero),
    options, best, second,
    gap: Number.isFinite(gap) ? gap : 0,
    mixed: second >= 0 && Number.isFinite(gap) && gap <= tau,
    rare: rareSteps(result, trail).length > 0,
  };
}

export function enumerateSituations(tree: LightTree, result: SolveResult, hero: number, hand: number): Situation[] {
  const out: Situation[] = [];
  const tauBB = tree.config.smoothing ?? 0;
  const tau = playerTemperatures(tree, tauBB, tree.config.mode)[hero];
  const trail: TrailStep[] = [];
  const path: number[] = [];

  const visit = (id: number, depth: number, reach: number): void => {
    const node = tree.nodes[id];
    if (node.kind !== 'decision') return;
    if (node.player === hero) {
      if (depth >= MAX_HERO_DECISIONS) return;
      out.push(buildSituation(tree, result, node, path.slice(), trail.slice(), depth, reach, hand, hero, tau));
    }
    // 상대 좌석은 레인지 전체의 빈도, 히어로 자신은 선택한 핸드의 빈도로 가중한다
    const freqs = node.player === hero
      ? node.actions.map((_, a) => freqOf(result, node, a, hand))
      : actionTotals(result, node, playerReach(result, trail, node.player)).freq;
    for (let a = 0; a < node.actions.length; a++) {
      const next = reach * freqs[a];
      if (next < MIN_REACH) continue;
      trail.push({ node, action: a });
      path.push(a);
      visit(node.actions[a].child, node.player === hero ? depth + 1 : depth, next);
      path.pop();
      trail.pop();
    }
  };

  visit(0, 0, 1);
  out.sort((x, y) => x.depth - y.depth || y.reach - x.reach);
  return out;
}
