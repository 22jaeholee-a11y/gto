// Independent Monte Carlo reference for auditing solver EVs.
//
// Deals real cards to every seat with exact joint card removal (sequential importance sampling
// over each opponent's reach-weighted range), plays the rest of the tree by sampling the solved
// average strategy, deals a real board, evaluates hands, splits side pots with ties, and applies
// ICM to the final stacks. Flop terminals are only supported with a neutral postflop model
// (no realization adjustment, no pot growth), where they reduce to a showdown for the pot.

import { classCombos, NUM_CLASSES } from './cards';
import { evaluate7 } from './evaluator';
import { icmEquity } from './icm';
import type { SolveResult } from './solver';
import type { DecisionNode, GameTree, TerminalNode } from './tree';

const N = NUM_CLASSES;

interface Combo { c1: number; c2: number; cls: number }
const COMBO_LIST: Combo[] = [];
const COMBO_AT = new Int16Array(52 * 52).fill(-1);
for (let cls = 0; cls < N; cls++) {
  for (const [c1, c2] of classCombos(cls)) {
    COMBO_AT[c1 * 52 + c2] = COMBO_LIST.length;
    COMBO_AT[c2 * 52 + c1] = COMBO_LIST.length;
    COMBO_LIST.push({ c1, c2, cls });
  }
}
const NC = COMBO_LIST.length; // 1326

export function isNeutralPostflop(tree: GameTree): boolean {
  const pf = tree.config.postflop;
  if (pf.potGrowth !== 0 || pf.playability !== 0) return false;
  if (pf.aggressor && (pf.aggressor.ip !== 1 || pf.aggressor.oop !== 1)) return false;
  return Object.values(pf.eqrByPlayers).every((arr) => arr.every((x) => x === 1));
}

export function walkPathIds(tree: GameTree, path: number[]): { node: DecisionNode; steps: Array<{ node: DecisionNode; action: number }> } {
  let node = tree.nodes[0];
  const steps: Array<{ node: DecisionNode; action: number }> = [];
  for (const a of path) {
    if (node.kind !== 'decision') throw new Error('path passes a terminal');
    steps.push({ node, action: a });
    node = tree.nodes[node.actions[a].child];
  }
  if (node.kind !== 'decision') throw new Error('path must end at a decision node');
  return { node, steps };
}

export interface HandReference {
  hand: number;
  samples: number;
  /** effective sample size of the importance weights */
  ess: number;
  evIcm: number[];
  evChip: number[];
  seIcm: number[];
  seChip: number[];
  /** E[u_a - u_strategy] and its standard error (common random numbers across actions) */
  advIcm: number[];
  advChip: number[];
  advSeIcm: number[];
  advSeChip: number[];
}

function rng(seed: number) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Chips won per seat for real hand strengths (-1 = folded); ties split each layer. */
export function payoutWithTies(contrib: number[], folded: boolean[], dead: number, strength: number[]): number[] {
  const n = contrib.length;
  const win = new Array(n).fill(0);
  const live = [];
  for (let j = 0; j < n; j++) if (!folded[j]) live.push(j);
  const levels = Array.from(new Set(live.map((j) => contrib[j]))).sort((a, b) => a - b);
  let prev = 0;
  for (let li = 0; li < levels.length; li++) {
    const level = levels[li];
    let layer = li === 0 ? dead : 0;
    for (let j = 0; j < n; j++) layer += Math.min(contrib[j], level) - Math.min(contrib[j], prev);
    let best = -1;
    for (const j of live) if (contrib[j] >= level - 1e-9 && strength[j] > best) best = strength[j];
    const winners = live.filter((j) => contrib[j] >= level - 1e-9 && strength[j] === best);
    for (const j of winners) win[j] += layer / winners.length;
    prev = level;
  }
  return win;
}

/**
 * foldedMode (players who folded before the spot):
 *  'range'   exact: dealt from their folding ranges, cards removed from everyone else and the board
 *  'uniform' dealt uniformly at random (removes the fold-range card-removal effect)
 *  'noBoard' dealt from folding ranges, but the board ignores their cards (range effect only)
 */
export type FoldedMode = 'range' | 'uniform' | 'noBoard';

export function referenceHand(
  tree: GameTree,
  result: SolveResult,
  path: number[],
  hand: number,
  samples: number,
  seed: number,
  foldedMode: FoldedMode = 'range',
): HandReference {
  const { node: spot, steps } = walkPathIds(tree, path);
  const n = tree.numPlayers;
  const q = spot.player;
  const A = spot.actions.length;
  const cfg = tree.config;
  const neutral = isNeutralPostflop(tree);
  const payTotal = cfg.payouts.reduce((a, b) => a + b, 0) || 1;
  const payouts = cfg.payouts.map((p) => p / payTotal);
  const BB = n - 1;
  const dead = Math.min(cfg.ante, cfg.stacks[BB]);
  const strat = result.strategy;
  const off = (nd: DecisionNode) => result.offsets[nd.dIndex];
  const foldedBefore = new Set(steps.filter((st) => st.node.actions[st.action].type === 'fold').map((st) => st.node.player));

  // per-combo reach of each opponent at the spot
  const reach: Float64Array[] = [];
  const cum: Float64Array[] = [];
  const cardSum: Float64Array[] = [];
  const total: number[] = [];
  for (let p = 0; p < n; p++) {
    const r = new Float64Array(NC);
    const cs = new Float64Array(52);
    const cu = new Float64Array(NC);
    let t = 0;
    if (p !== q) {
      const clsReach = new Float64Array(N).fill(1);
      for (const st of steps) {
        if (st.node.player !== p || (foldedMode === 'uniform' && foldedBefore.has(p))) continue;
        const o = off(st.node) + st.action * N;
        for (let h = 0; h < N; h++) clsReach[h] *= strat[o + h];
      }
      for (let k = 0; k < NC; k++) {
        const v = clsReach[COMBO_LIST[k].cls];
        r[k] = v;
        t += v;
        cu[k] = t;
        cs[COMBO_LIST[k].c1] += v;
        cs[COMBO_LIST[k].c2] += v;
      }
    }
    reach.push(r); cum.push(cu); cardSum.push(cs); total.push(t);
  }

  const rand = rng(seed);
  const heroCombos = classCombos(hand);
  const sigma = Array.from({ length: A }, (_, a) => strat[off(spot) + a * N + hand]);

  const sw = { w: 0, w2: 0 };
  const acc = {
    icm: new Float64Array(A), chip: new Float64Array(A),
    icm2: new Float64Array(A), chip2: new Float64Array(A),
    advIcm: new Float64Array(A), advChip: new Float64Array(A),
    advIcm2: new Float64Array(A), advChip2: new Float64Array(A),
  };

  const used = new Uint8Array(52);
  const hole = new Int32Array(n * 2);
  const cls = new Int32Array(n);
  const dealt: number[] = [];
  const deck = new Int32Array(52);
  const seven = new Int32Array(7);
  const strength = new Array(n).fill(-1);
  const uIcm = new Float64Array(A);
  const uChip = new Float64Array(A);

  const sampleOpp = (p: number): number => {
    const t = total[p];
    for (let tries = 0; tries < 200; tries++) {
      const x = rand() * t;
      let lo = 0, hi = NC - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[p][mid] > x) hi = mid; else lo = mid + 1; }
      const cb = COMBO_LIST[lo];
      if (!used[cb.c1] && !used[cb.c2] && reach[p][lo] > 0) return lo;
    }
    // heavy removal: enumerate compatible combos
    let z = 0;
    for (let k = 0; k < NC; k++) { const cb = COMBO_LIST[k]; if (!used[cb.c1] && !used[cb.c2]) z += reach[p][k]; }
    let x = rand() * z;
    for (let k = 0; k < NC; k++) {
      const cb = COMBO_LIST[k];
      if (used[cb.c1] || used[cb.c2]) continue;
      x -= reach[p][k];
      if (x <= 0 && reach[p][k] > 0) return k;
    }
    return -1;
  };

  let done = 0;
  for (let s = 0; s < samples; s++) {
    used.fill(0);
    dealt.length = 0;
    const [h1, h2] = heroCombos[(rand() * heroCombos.length) | 0];
    hole[q * 2] = h1; hole[q * 2 + 1] = h2; cls[q] = hand;
    used[h1] = 1; used[h2] = 1; dealt.push(h1, h2);

    let w = 1;
    for (let p = 0; p < n && w > 0; p++) {
      if (p === q) continue;
      // normalizer over compatible combos via inclusion-exclusion on dealt cards
      let z = total[p];
      for (let i = 0; i < dealt.length; i++) {
        z -= cardSum[p][dealt[i]];
        for (let j = i + 1; j < dealt.length; j++) z += reach[p][COMBO_AT[dealt[i] * 52 + dealt[j]]];
      }
      if (z <= 1e-12) { w = 0; break; }
      const k = sampleOpp(p);
      if (k < 0) { w = 0; break; }
      w *= z;
      const cb = COMBO_LIST[k];
      hole[p * 2] = cb.c1; hole[p * 2 + 1] = cb.c2; cls[p] = cb.cls;
      used[cb.c1] = 1; used[cb.c2] = 1; dealt.push(cb.c1, cb.c2);
    }
    if (w === 0) continue;

    // board
    let m = 0;
    if (foldedMode === 'noBoard') {
      const live = new Uint8Array(52);
      for (let p = 0; p < n; p++) if (!foldedBefore.has(p)) { live[hole[p * 2]] = 1; live[hole[p * 2 + 1]] = 1; }
      for (let c = 0; c < 52; c++) if (!live[c]) deck[m++] = c;
    } else {
      for (let c = 0; c < 52; c++) if (!used[c]) deck[m++] = c;
    }
    for (let k = 0; k < 5; k++) {
      const j = k + ((rand() * (m - k)) | 0);
      const t = deck[k]; deck[k] = deck[j]; deck[j] = t;
    }
    strength.fill(-2);

    for (let a = 0; a < A; a++) {
      let nd = tree.nodes[spot.actions[a].child];
      while (nd.kind === 'decision') {
        const o = off(nd);
        const c = cls[nd.player];
        let x = rand();
        let pick = nd.actions.length - 1;
        for (let b = 0; b < nd.actions.length; b++) {
          x -= strat[o + b * N + c];
          if (x <= 0) { pick = b; break; }
        }
        nd = tree.nodes[nd.actions[pick].child];
      }
      const t = nd as TerminalNode;
      if (t.tType === 'fold') {
        uIcm[a] = t.utilIcm[q];
        uChip[a] = t.utilChip[q];
        continue;
      }
      if (t.tType === 'flop' && !neutral) throw new Error('flop terminals need a neutral postflop model for the reference');
      const st = new Array(n).fill(-1);
      for (const p of t.participants) {
        if (strength[p] === -2) {
          seven[0] = hole[p * 2]; seven[1] = hole[p * 2 + 1];
          for (let k = 0; k < 5; k++) seven[2 + k] = deck[k];
          strength[p] = evaluate7(seven);
        }
        st[p] = strength[p];
      }
      const win = payoutWithTies(t.contrib, t.folded, dead, st);
      const final = cfg.stacks.map((s0, j) => s0 - (j === BB ? dead : 0) - t.contrib[j] + win[j]);
      uChip[a] = final[q] - cfg.stacks[q];
      uIcm[a] = icmEquity(final, payouts, cfg.stacks)[q] * 100 - tree.startIcm[q];
    }

    let mIcm = 0, mChip = 0;
    for (let a = 0; a < A; a++) { mIcm += sigma[a] * uIcm[a]; mChip += sigma[a] * uChip[a]; }
    sw.w += w; sw.w2 += w * w;
    for (let a = 0; a < A; a++) {
      acc.icm[a] += w * uIcm[a]; acc.icm2[a] += w * uIcm[a] * uIcm[a];
      acc.chip[a] += w * uChip[a]; acc.chip2[a] += w * uChip[a] * uChip[a];
      const di = uIcm[a] - mIcm, dc = uChip[a] - mChip;
      acc.advIcm[a] += w * di; acc.advIcm2[a] += w * di * di;
      acc.advChip[a] += w * dc; acc.advChip2[a] += w * dc * dc;
    }
    done++;
  }

  const ess = sw.w2 > 0 ? (sw.w * sw.w) / sw.w2 : 0;
  const mean = (x: number) => (sw.w > 0 ? x / sw.w : NaN);
  const se = (sum: number, sum2: number) => {
    const mu = mean(sum);
    const variance = Math.max(0, mean(sum2) - mu * mu);
    return ess > 1 ? Math.sqrt(variance / ess) : NaN;
  };
  const arr = (f: (a: number) => number) => Array.from({ length: A }, (_, a) => f(a));
  return {
    hand,
    samples: done,
    ess,
    evIcm: arr((a) => mean(acc.icm[a])),
    evChip: arr((a) => mean(acc.chip[a])),
    seIcm: arr((a) => se(acc.icm[a], acc.icm2[a])),
    seChip: arr((a) => se(acc.chip[a], acc.chip2[a])),
    advIcm: arr((a) => mean(acc.advIcm[a])),
    advChip: arr((a) => mean(acc.advChip[a])),
    advSeIcm: arr((a) => se(acc.advIcm[a], acc.advIcm2[a])),
    advSeChip: arr((a) => se(acc.advChip[a], acc.advChip2[a])),
  };
}
