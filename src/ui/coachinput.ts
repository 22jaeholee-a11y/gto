// 솔버 탭 상황 상세에서 쓰는 프리플랍 코치 해설 입력.
// 워커가 보내는 LightTerminal에는 종료 노드의 유틸리티가 없어서, 헤즈업 올인 쇼다운의
// 승·패 결과를 엔진(buildTree)과 같은 식으로 다시 계산한다.

import { classLabel } from '../engine/cards';
import { icmEquity } from '../engine/icm';
import { anteBySeat, normalizedPayouts } from '../engine/postflop/spot';
import type { SolveResult } from '../engine/solver';
import type { PreflopCoachInput } from '../engine/training/coach';
import { distributeSidePots } from '../engine/tree';
import type { LightDecision, LightTerminal, LightTree } from '../worker/protocol';
import { actionTotals, evOf, freqOf, label, playerReach, type TrailStep } from './spot';

export interface ShowdownUtilities {
  winIcm: number;
  loseIcm: number;
  winChip: number;
  loseChip: number;
}

/** 히어로가 이 헤즈업 올인 쇼다운에서 이기면 / 지면 얻는 값 (핸드 시작 대비). */
export function showdownUtilities(tree: LightTree, terminal: LightTerminal, hero: number): ShowdownUtilities | null {
  if (terminal.tType !== 'showdown') return null;
  if (terminal.participants.length !== 2) return null;
  if (!terminal.participants.includes(hero)) return null;
  const { stacks } = tree.config;
  const n = stacks.length;
  const ante = anteBySeat(tree.config);
  const payouts = normalizedPayouts(tree.config);
  const villain = terminal.participants.find((s) => s !== hero)!;
  const baseStacks = stacks.map((s, i) => s - ante[i] - terminal.contrib[i]);
  const settle = (order: number[]): number[] => {
    const f = baseStacks.slice();
    const win = distributeSidePots(terminal.contrib, terminal.folded, ante[n - 1], order);
    for (let j = 0; j < n; j++) f[j] += win[j];
    return f;
  };
  const fWin = settle([hero, villain]);
  const fLose = settle([villain, hero]);
  const start = tree.startIcm[hero];
  return {
    winIcm: icmEquity(fWin, payouts, stacks)[hero] * 100 - start,
    loseIcm: icmEquity(fLose, payouts, stacks)[hero] * 100 - start,
    winChip: fWin[hero] - stacks[hero],
    loseChip: fLose[hero] - stacks[hero],
  };
}

/**
 * 콜이 (뒤가 모두 폴드해) 헤즈업 올인 쇼다운으로 이어질 때, 콜이 폴드를 이기는 데 필요한 에퀴티.
 * 그런 라인이 없으면 null.
 */
export function requiredEquity(
  tree: LightTree, result: SolveResult, node: LightDecision, hand: number, hero: number,
): { chip: number | null; icm: number | null } {
  const callIdx = node.actions.findIndex((a) => a.type === 'call');
  const foldIdx = node.actions.findIndex((a) => a.type === 'fold');
  if (callIdx < 0 || foldIdx < 0) return { chip: null, icm: null };
  // 콜 뒤로 폴드만 따라가 종료 노드에 닿는다 (엔진의 explainPreflopDecision과 같은 규칙)
  let id = node.actions[callIdx].child;
  for (let guard = 0; guard < 12; guard++) {
    const x = tree.nodes[id];
    if (x.kind === 'terminal') {
      const u = showdownUtilities(tree, x, hero);
      if (!u) return { chip: null, icm: null };
      const fI = evOf(result.evIcm, result, node, foldIdx, hand);
      const fC = evOf(result.evChip, result, node, foldIdx, hand);
      const clamp = (x0: number) => Math.min(1, Math.max(0, x0));
      return {
        icm: Number.isFinite(fI) && u.winIcm !== u.loseIcm ? clamp((fI - u.loseIcm) / (u.winIcm - u.loseIcm)) : null,
        chip: Number.isFinite(fC) && u.winChip !== u.loseChip ? clamp((fC - u.loseChip) / (u.winChip - u.loseChip)) : null,
      };
    }
    const fold = x.actions.findIndex((a) => a.type === 'fold');
    if (fold < 0) break;
    id = x.actions[fold].child;
  }
  return { chip: null, icm: null };
}

export function buildPreflopCoachInput(
  tree: LightTree, result: SolveResult, trail: TrailStep[], node: LightDecision,
  hand: number, chosen: number, best: number,
): PreflopCoachInput {
  const hero = node.player;
  const n = tree.config.stacks.length;
  const primary = tree.config.mode;
  const labels = node.actions.map((a) => label(a, node));
  const freq = node.actions.map((_, i) => freqOf(result, node, i, hand));
  const evIcm = node.actions.map((_, i) => finite(evOf(result.evIcm, result, node, i, hand)));
  const evChip = node.actions.map((_, i) => finite(evOf(result.evChip, result, node, i, hand)));
  const key = primary === 'icm' ? evIcm : evChip;
  const loss = Math.max(0, (key[best] ?? 0) - (key[chosen] ?? 0));
  const lossBB = primary === 'icm' ? loss / bbPerIcm(tree, hero) : loss;

  // 히어로 앞의 마지막 레이저
  let aggressor: number | null = null;
  for (const st of trail) {
    const t = st.node.actions[st.action].type;
    if (t === 'raise' || t === 'allin') aggressor = st.node.player;
  }
  const req = requiredEquity(tree, result, node, hand, hero);
  let playersLeft = 0;
  for (let s = hero + 1; s < n; s++) if (!node.folded[s]) playersLeft++;
  const reach = playerReach(result, trail, hero);
  const totals = actionTotals(result, node, reach);
  const openShare = node.actions.reduce(
    (acc, a, i) => acc + (a.type === 'raise' || a.type === 'allin' ? totals.freq[i] : 0), 0,
  );

  return {
    hand: classLabel(hand),
    labels,
    kinds: node.actions.map((a) => a.type),
    freq,
    evIcm,
    evChip,
    chosen, best, primary, loss, lossBB,
    heroClass: hand,
    heroName: tree.seatNames[hero],
    seatNames: tree.seatNames,
    hero,
    pot: node.pot,
    toCall: Math.max(0, Math.min(node.bet - node.contrib[hero], node.behind[hero])),
    heroContrib: node.contrib[hero],
    heroBehind: node.behind[hero],
    isBlind: hero >= n - 2,
    aggressor,
    aggressorAllin: aggressor !== null && node.allin[aggressor],
    villainReach: aggressor !== null ? playerReach(result, trail, aggressor) : null,
    requiredChip: req.chip,
    requiredIcm: req.icm,
    playersLeft,
    heroOpenShare: aggressor === null ? openShare : null,
    startStacks: tree.config.stacks.slice(),
    payouts: normalizedPayouts(tree.config),
  };
}

function finite(x: number): number | null {
  return Number.isFinite(x) ? x : null;
}

/** ICM %p 한 단위가 몇 bb인지 (손실을 bb로 환산할 때 쓴다). */
function bbPerIcm(tree: LightTree, seat: number): number {
  const { stacks } = tree.config;
  const payouts = normalizedPayouts(tree.config);
  const n = stacks.length;
  const moved = (d: number) => {
    const x = stacks.slice();
    x[seat] += d;
    for (let j = 0; j < n; j++) if (j !== seat) x[j] -= d / (n - 1);
    return icmEquity(x, payouts)[seat] * 100;
  };
  const d = Math.min(0.5, stacks[seat] / 2);
  const slope = (moved(d) - moved(-d)) / (2 * d);
  return Math.max(1e-6, slope);
}

export type { PreflopCoachInput };
