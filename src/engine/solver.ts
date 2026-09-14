// Vector-form Discounted CFR with simultaneous updates over 169 hand classes.
//
// reach[p][h]  = product of p's own action probabilities along the path (per combo of class h)
// cm[p][h]     = (COMPAT · reach[p])[h]: p's range mass compatible with a hero combo of class h
// cfv[p][h]    = counterfactual value for p holding class h = sum over opponent holdings of
//                (opponent reach × utility), with card removal between the hero and each opponent.

import { COMBOS, compatMul, NUM_CLASSES } from './cards';
import { matVec, WIN } from './equity';
import type { DecisionNode, GameTree, TerminalNode } from './tree';

const N = NUM_CLASSES;
const ALPHA = 1.5;
const GAMMA = 2;

export interface SolveProgress {
  iteration: number;
  /** average best-response gain per player, % of prize pool (icm) or bb (chip) */
  exploitability?: number;
}

export interface SolveResult {
  /** offsets[dIndex] into the per-action arrays (169 entries per action) */
  offsets: Int32Array;
  strategy: Float32Array;
  evIcm: Float32Array;
  evChip: Float32Array;
  /** expected result per seat at the root */
  rootIcm: number[];
  rootChip: number[];
  exploitability: number;
  iterations: number;
}

export const PLAYABILITY: Float64Array = (() => {
  const a = new Float64Array(N);
  for (let idx = 0; idx < N; idx++) {
    const r = Math.floor(idx / 13), c = idx % 13;
    const hi = 12 - Math.min(r, c), lo = 12 - Math.max(r, c);
    const pair = r === c, suited = r < c, gap = hi - lo - 1;
    let adj = 0;
    if (pair) adj += 0.02;
    if (suited) adj += 0.06;
    if (!pair) {
      if (gap === 0) adj += 0.03;
      else if (gap === 1) adj += 0.015;
      if (!suited && gap >= 3) adj -= 0.04;
      if (!suited && lo < 8) adj -= 0.03;
    }
    a[idx] = adj;
  }
  return a;
})();

export type Pass = 'train' | 'ev' | 'br';

/** lazily computed WIN · reach for one reach vector */
interface WvSlot { vec: Float64Array; ok: boolean }

/**
 * Restricts a solver to part of the tree, for parallel solving.
 * roots: subtrees this solver owns. frontier: node ids where the walk stops and
 * uses externally computed values instead (the coordinator's view of worker subtrees).
 */
export interface TreePart {
  roots: number[];
  frontier?: number[];
}

export class Solver {
  readonly tree: GameTree;
  readonly n: number;
  /** offsets[dIndex] into regrets/stratSum, -1 for decisions this solver does not own */
  readonly offsets: Int32Array;
  readonly regrets: Float64Array;
  readonly stratSum: Float64Array;
  readonly owned: DecisionNode[] = [];
  private iteration = 0;
  private pass: Pass = 'train';
  private useAverage = false;
  private collecting = false;
  private frontierIds: Set<number> | null = null;
  private frontierOut: Map<number, Float64Array> | null = null;
  private collected: Array<{ id: number; reach: Float64Array }> = [];
  private util: 'icm' | 'chip';
  private evOut: Float32Array | null = null;
  private pool: Array<{ reach: Float64Array; cm: Float64Array; wv: WvSlot; out: Float64Array; act: Float64Array; sigma: Float64Array; mass: Float64Array; saved: Float64Array; value: Float64Array }> = [];
  /** per node id: outcome index for participant-index ranking (i*9 + j*3 + k), or winner index for 2-way */
  private orderIdx: Array<Int8Array | null> = [];
  private isPart = new Int8Array(8);
  private S = new Float64Array(16);
  private tmp = { prod: new Float64Array(0), accum: new Float64Array(N), wv: [] as Float64Array[], b: [] as Float64Array[] };

  constructor(tree: GameTree, part: TreePart = { roots: [0] }) {
    this.tree = tree;
    this.n = tree.numPlayers;
    this.util = tree.config.mode;
    this.offsets = new Int32Array(tree.numDecisions).fill(-1);
    if (part.frontier?.length) this.frontierIds = new Set(part.frontier);
    const stack = part.roots.slice().reverse();
    while (stack.length) {
      const id = stack.pop()!;
      const nd = tree.nodes[id];
      if (nd.kind !== 'decision' || this.frontierIds?.has(id)) continue;
      this.owned.push(nd);
      for (let a = nd.actions.length - 1; a >= 0; a--) stack.push(nd.actions[a].child);
    }
    let off = 0;
    for (const nd of this.owned) {
      this.offsets[nd.dIndex] = off;
      off += nd.actions.length * N;
    }
    this.regrets = new Float64Array(off);
    this.stratSum = new Float64Array(off);
    this.tmp.prod = new Float64Array(this.n * N);
    for (const nd of tree.nodes) {
      if (nd.kind !== 'terminal' || nd.tType !== 'showdown') { this.orderIdx.push(null); continue; }
      const k = nd.participants.length;
      const tbl = new Int8Array(k === 2 ? 4 : 27).fill(-1);
      nd.outcomes.forEach((ord, o) => {
        const ix = ord.map((seat) => nd.participants.indexOf(seat));
        if (k === 2) tbl[ix[0] * 2 + ix[1]] = o;
        else tbl[ix[0] * 9 + ix[1] * 3 + ix[2]] = o;
      });
      this.orderIdx.push(tbl);
    }
    for (let i = 0; i < 4; i++) { this.tmp.wv.push(new Float64Array(N)); this.tmp.b.push(new Float64Array(N)); }
  }

  get iterations() { return this.iteration; }

  private buffers(depth: number) {
    while (this.pool.length <= depth) {
      this.pool.push({
        reach: new Float64Array(N),
        cm: new Float64Array(N),
        wv: { vec: new Float64Array(N), ok: false },
        out: new Float64Array(this.n * N),
        act: new Float64Array(8 * N),
        sigma: new Float64Array(8 * N),
        mass: new Float64Array(N),
        saved: new Float64Array(N),
        value: new Float64Array(N),
      });
    }
    return this.pool[depth];
  }

  private rootVectors() {
    const reach: Float64Array[] = [];
    const cm: Float64Array[] = [];
    const wv: WvSlot[] = [];
    for (let p = 0; p < this.n; p++) {
      reach.push(new Float64Array(N).fill(1));
      cm.push(new Float64Array(N).fill(1));
      wv.push({ vec: new Float64Array(N), ok: false });
    }
    return { reach, cm, wv };
  }

  set iterations(t: number) { this.iteration = t; }

  private setPass(pass: Pass, util: 'icm' | 'chip', store: Float32Array | null) {
    this.pass = pass;
    this.useAverage = pass !== 'train';
    this.util = util;
    this.evOut = store;
  }

  /** Walk from the root; returns the root cfv vectors (n × 169). */
  private walkRoot(): Float64Array {
    const { reach, cm, wv } = this.rootVectors();
    const out = new Float64Array(this.n * N);
    this.walk(0, 0, reach, cm, wv, out);
    return out;
  }

  /** Run `count` DCFR iterations. */
  run(count: number): void {
    for (let k = 0; k < count; k++) {
      this.iteration++;
      this.setPass('train', this.tree.config.mode, null);
      this.walkRoot();
    }
  }

  /** Expected value per seat (root) under the average strategy, plus per-action EVs if `store`. */
  evaluate(util: 'icm' | 'chip', store?: Float32Array): number[] {
    this.setPass('ev', util, store ?? null);
    const out = this.walkRoot();
    this.evOut = null;
    return rootValues(out, this.n);
  }

  bestResponse(util: 'icm' | 'chip'): number[] {
    this.setPass('br', util, null);
    return rootValues(this.walkRoot(), this.n);
  }

  exploitability(): number {
    const util = this.tree.config.mode;
    return exploitabilityOf(this.evaluate(util), this.bestResponse(util));
  }

  // ---- parallel solving: coordinator side ----

  /** Reach vectors (n × 169 per item) arriving at each frontier node for this pass. */
  collectFrontier(pass: Pass, util: 'icm' | 'chip'): Array<{ id: number; reach: Float64Array }> {
    this.setPass(pass, util, null);
    this.collecting = true;
    this.collected = [];
    try {
      this.walkRoot();
    } finally {
      this.collecting = false;
    }
    return this.collected;
  }

  /** Complete the pass using frontier results; returns root cfv vectors (n × 169). */
  applyFrontier(pass: Pass, util: 'icm' | 'chip', results: Map<number, Float64Array>, store?: Float32Array): Float64Array {
    this.setPass(pass, util, store ?? null);
    this.frontierOut = results;
    try {
      return this.walkRoot();
    } finally {
      this.frontierOut = null;
      this.evOut = null;
    }
  }

  // ---- parallel solving: worker side ----

  /**
   * Walk owned subtrees given the reach vectors at their roots.
   * reach holds n × 169 values per id; returns n × 169 cfv values per id.
   */
  runSubtrees(pass: Pass, util: 'icm' | 'chip', t: number, ids: ArrayLike<number>, reach: Float64Array, store?: Float32Array): Float64Array {
    this.iteration = t;
    this.setPass(pass, util, store ?? null);
    const n = this.n;
    const outs = new Float64Array(ids.length * n * N);
    for (let i = 0; i < ids.length; i++) {
      const r: Float64Array[] = [];
      const cm: Float64Array[] = [];
      const wv: WvSlot[] = [];
      for (let p = 0; p < n; p++) {
        const v = reach.slice((i * n + p) * N, (i * n + p + 1) * N);
        r.push(v);
        const c = new Float64Array(N);
        compatMul(v, c);
        cm.push(c);
        wv.push({ vec: new Float64Array(N), ok: false });
      }
      this.walk(ids[i], 0, r, cm, wv, outs.subarray(i * n * N, (i + 1) * n * N));
    }
    this.evOut = null;
    return outs;
  }

  averageStrategy(): Float32Array {
    const res = new Float32Array(this.stratSum.length);
    for (const nd of this.owned) {
      const A = nd.actions.length;
      const off = this.offsets[nd.dIndex];
      for (let h = 0; h < N; h++) {
        let sum = 0;
        for (let a = 0; a < A; a++) sum += this.stratSum[off + a * N + h];
        for (let a = 0; a < A; a++) res[off + a * N + h] = sum > 0 ? this.stratSum[off + a * N + h] / sum : 1 / A;
      }
    }
    return res;
  }

  private currentStrategy(nd: DecisionNode, sigma: Float64Array) {
    const A = nd.actions.length;
    const off = this.offsets[nd.dIndex];
    if (!this.useAverage) {
      for (let h = 0; h < N; h++) {
        let sum = 0;
        for (let a = 0; a < A; a++) { const r = this.regrets[off + a * N + h]; if (r > 0) sum += r; }
        for (let a = 0; a < A; a++) {
          const r = this.regrets[off + a * N + h];
          sigma[a * N + h] = sum > 0 ? (r > 0 ? r / sum : 0) : 1 / A;
        }
      }
    } else {
      for (let h = 0; h < N; h++) {
        let sum = 0;
        for (let a = 0; a < A; a++) sum += this.stratSum[off + a * N + h];
        for (let a = 0; a < A; a++) sigma[a * N + h] = sum > 0 ? this.stratSum[off + a * N + h] / sum : 1 / A;
      }
    }
  }

  private walk(id: number, depth: number, reach: Float64Array[], cm: Float64Array[], wv: WvSlot[], out: Float64Array): void {
    if (this.frontierIds?.has(id)) {
      if (this.collecting) {
        const r = new Float64Array(this.n * N);
        for (let p = 0; p < this.n; p++) r.set(reach[p], p * N);
        this.collected.push({ id, reach: r });
      } else {
        const res = this.frontierOut!.get(id)!;
        for (let i = 0; i < res.length; i++) out[i] += res[i];
      }
      return;
    }
    const nd = this.tree.nodes[id];
    if (nd.kind === 'terminal') {
      if (!this.collecting) this.terminal(nd, reach, cm, wv, out);
      return;
    }

    const n = this.n;
    const q = nd.player;
    const A = nd.actions.length;
    const buf = this.buffers(depth);
    const { sigma, act } = buf;
    this.currentStrategy(nd, sigma);
    // walk() adds into out; isolate the acting player's segment per action
    const qb = q * N;
    const saved = buf.saved;
    for (let h = 0; h < N; h++) { saved[h] = out[qb + h]; out[qb + h] = 0; }

    const parentReach = reach[q];
    const parentCm = cm[q];
    const parentWv = wv[q];
    const childReach = buf.reach;
    const childCm = buf.cm;

    for (let a = 0; a < A; a++) {
      let any = false;
      for (let h = 0; h < N; h++) {
        const v = parentReach[h] * sigma[a * N + h];
        childReach[h] = v;
        if (v !== 0) any = true;
      }
      if (this.collecting) { /* only reach is needed on the way to the frontier */ }
      else if (any) compatMul(childReach, childCm);
      else childCm.fill(0);
      buf.wv.ok = false;
      reach[q] = childReach;
      cm[q] = childCm;
      wv[q] = buf.wv;
      this.walk(nd.actions[a].child, depth + 1, reach, cm, wv, out);
      reach[q] = parentReach;
      cm[q] = parentCm;
      wv[q] = parentWv;
      for (let h = 0; h < N; h++) { act[a * N + h] = out[qb + h]; out[qb + h] = 0; }
    }

    if (this.collecting) return;
    if (this.pass === 'br') {
      for (let h = 0; h < N; h++) {
        let best = -Infinity;
        for (let a = 0; a < A; a++) if (act[a * N + h] > best) best = act[a * N + h];
        out[qb + h] = saved[h] + best;
      }
      return;
    }
    const value = buf.value;
    for (let h = 0; h < N; h++) {
      let v = 0;
      for (let a = 0; a < A; a++) v += sigma[a * N + h] * act[a * N + h];
      value[h] = v;
      out[qb + h] = saved[h] + v;
    }

    const off = this.offsets[nd.dIndex];
    if (this.pass === 'train') {
      const t = this.iteration;
      const pw = Math.pow(t, ALPHA);
      const posD = pw / (pw + 1);
      const negD = 0.5;
      const sD = Math.pow(t / (t + 1), GAMMA);
      for (let a = 0; a < A; a++) {
        for (let h = 0; h < N; h++) {
          const i = off + a * N + h;
          const r = this.regrets[i];
          this.regrets[i] = r * (r > 0 ? posD : negD) + (act[a * N + h] - value[h]);
          this.stratSum[i] = this.stratSum[i] * sD + sigma[a * N + h] * parentReach[h];
        }
      }
    } else if (this.evOut) {
      // normalize by the probability that opponents reach this node
      const mass = buf.mass;
      mass.fill(1);
      for (let p = 0; p < n; p++) {
        if (p === q) continue;
        const c = cm[p];
        for (let h = 0; h < N; h++) mass[h] *= c[h];
      }
      for (let a = 0; a < A; a++)
        for (let h = 0; h < N; h++)
          this.evOut[off + a * N + h] = mass[h] > 1e-300 ? act[a * N + h] / mass[h] : NaN;
    }
  }

  /** products of cm over all seats except p (and except `skip`), written to prod[p*N + h] */
  private prodExcept(cm: Float64Array[], prod: Float64Array) {
    const n = this.n;
    for (let h = 0; h < N; h++) {
      let left = 1;
      for (let p = 0; p < n; p++) { prod[p * N + h] = left; left *= cm[p][h]; }
      let right = 1;
      for (let p = n - 1; p >= 0; p--) { prod[p * N + h] *= right; right *= cm[p][h]; }
    }
  }

  private terminal(t: TerminalNode, reach: Float64Array[], cm: Float64Array[], wv: WvSlot[], out: Float64Array) {
    const n = this.n;
    const U = this.util === 'icm' ? t.utilIcm : t.utilChip;
    const prod = this.tmp.prod;
    this.prodExcept(cm, prod);

    if (t.tType === 'fold') {
      for (let p = 0; p < n; p++) {
        const u = U[p];
        const base = p * N;
        for (let h = 0; h < N; h++) out[base + h] += u * prod[base + h];
      }
      return;
    }

    const parts = t.participants;
    const k = parts.length;
    const isPart = this.isPart;
    isPart.fill(-1);
    for (let i = 0; i < k; i++) isPart[parts[i]] = i;

    // WV[i][h] = mass of participant i's range that a hero combo of class h beats
    const WV = this.tmp.wv;
    for (let i = 0; i < k; i++) {
      const slot = wv[parts[i]];
      if (!slot.ok) { matVec(WIN, reach[parts[i]], slot.vec); slot.ok = true; }
      WV[i] = slot.vec;
    }

    // scalar S[i][j] = P(range i beats range j)
    const S = this.S;
    for (let i = 0; i < k; i++) {
      S[i * 4 + i] = 0.5;
      const ri = reach[parts[i]];
      for (let j = 0; j < k; j++) {
        if (i === j) continue;
        let num = 0, den = 0;
        const cj = cm[parts[j]], wj = WV[j];
        for (let h = 0; h < N; h++) {
          const w = ri[h] * COMBOS[h];
          if (w === 0) continue;
          num += w * wj[h];
          den += w * cj[h];
        }
        S[i * 4 + j] = den > 0 ? num / den : 0.5;
      }
    }

    if (t.tType === 'showdown') this.showdown(t, U, reach, cm, out, prod, WV, S, isPart);
    else this.flop(t, U, reach, cm, out, prod, WV, S, isPart);
  }

  private showdown(
    t: TerminalNode, U: Float64Array, reach: Float64Array[], cm: Float64Array[], out: Float64Array,
    prod: Float64Array, WV: Float64Array[], S: Float64Array, isPart: Int8Array,
  ) {
    const n = this.n;
    const parts = t.participants;
    const k = parts.length;
    const O = t.outcomes.length;

    // folded seats: range-level ranking probabilities (pairwise product, normalized)
    const orderP = new Float64Array(O);
    let tot = 0;
    for (let o = 0; o < O; o++) {
      const ord = t.outcomes[o];
      let pr = 1;
      for (let x = 0; x < ord.length; x++)
        for (let y = x + 1; y < ord.length; y++) pr *= S[isPart[ord[x]] * 4 + isPart[ord[y]]];
      orderP[o] = pr;
      tot += pr;
    }
    for (let o = 0; o < O; o++) orderP[o] = tot > 0 ? orderP[o] / tot : 1 / O;

    for (let p = 0; p < n; p++) {
      const base = p * N;
      const ip = isPart[p];
      if (ip < 0) {
        let e = 0;
        for (let o = 0; o < O; o++) e += orderP[o] * U[o * n + p];
        for (let h = 0; h < N; h++) out[base + h] += prod[base + h] * e;
        continue;
      }
      if (k === 2) {
        const opp = parts[1 - ip];
        const oWin = this.orderIdx[t.id]![ip * 2 + (1 - ip)];
        const uWin = U[oWin * n + p];
        const uLose = U[(1 - oWin) * n + p];
        const cOpp = cm[opp];
        const wv = WV[1 - ip];
        for (let h = 0; h < N; h++) {
          // prod includes cOpp[h]; replace it by the win/lose split
          const c = cOpp[h];
          if (c <= 0) continue;
          const others = prod[base + h] / c;
          out[base + h] += others * (uLose * c + (uWin - uLose) * wv[h]);
        }
        continue;
      }
      // 3-way: pairwise-independence approximation conditioned on hero hand x vs others y, z
      const tbl = this.orderIdx[t.id]!;
      const y = ip === 0 ? 1 : 0;
      const z = ip === 2 ? 1 : 2;
      const syz = S[y * 4 + z];
      const u = (i0: number, i1: number, i2: number) => U[tbl[i0 * 9 + i1 * 3 + i2] * n + p];
      const cA = syz * u(ip, y, z) + (1 - syz) * u(ip, z, y); // hero first
      const cB = u(y, ip, z); // y > hero > z
      const cC = u(z, ip, y); // z > hero > y
      const cD = syz * u(y, z, ip) + (1 - syz) * u(z, y, ip); // hero last
      const cy = cm[parts[y]], wy = WV[y], cz = cm[parts[z]], wz = WV[z];
      const accum = this.tmp.accum;
      for (let h = 0; h < N; h++) {
        const by = cy[h] > 0 ? wy[h] / cy[h] : 0.5;
        const bz = cz[h] > 0 ? wz[h] / cz[h] : 0.5;
        accum[h] = by * bz * cA + (1 - by) * bz * cB + by * (1 - bz) * cC + (1 - by) * (1 - bz) * cD;
      }
      for (let h = 0; h < N; h++) out[base + h] += prod[base + h] * accum[h];
    }
  }

  private flop(
    t: TerminalNode, U: Float64Array, reach: Float64Array[], cm: Float64Array[], out: Float64Array,
    prod: Float64Array, WV: Float64Array[], S: Float64Array, isPart: Int8Array,
  ) {
    const n = this.n;
    const parts = t.participants;
    const k = parts.length;

    // range-level raw win probability and realization per participant
    const q = new Float64Array(k);
    const rbar = new Float64Array(k);
    for (let i = 0; i < k; i++) {
      let pr = 1;
      for (let j = 0; j < k; j++) if (j !== i) pr *= S[i * 4 + j];
      q[i] = pr;
      const r = reach[parts[i]];
      let num = 0, den = 0;
      for (let h = 0; h < N; h++) { const w = r[h] * COMBOS[h]; num += w * PLAYABILITY[h]; den += w; }
      rbar[i] = t.eqr[i] * (1 + (den > 0 ? num / den : 0) * t.playScale);
    }

    for (let p = 0; p < n; p++) {
      const base = p * N;
      const ip = isPart[p];
      if (ip < 0) {
        let tot = 0, e = 0;
        for (let i = 0; i < k; i++) tot += q[i] * rbar[i];
        for (let i = 0; i < k; i++) e += (tot > 0 ? (q[i] * rbar[i]) / tot : 1 / k) * U[i * n + p];
        for (let h = 0; h < N; h++) out[base + h] += prod[base + h] * e;
        continue;
      }
      // loss distribution: winner among the others ∝ q * rbar
      let tot = 0, uOthers = 0;
      for (let i = 0; i < k; i++) if (i !== ip) tot += q[i] * rbar[i];
      for (let i = 0; i < k; i++)
        if (i !== ip) uOthers += (tot > 0 ? (q[i] * rbar[i]) / tot : 1 / (k - 1)) * U[i * n + p];
      const uWin = U[ip * n + p];
      let qOthers = 0;
      for (let i = 0; i < k; i++) if (i !== ip) qOthers += q[i];
      const rOthers = qOthers > 0 ? tot / qOthers : 1;
      const eqrHero = t.eqr[ip];
      for (let h = 0; h < N; h++) {
        let raw = 1;
        for (let i = 0; i < k; i++) {
          if (i === ip) continue;
          const c = cm[parts[i]][h];
          raw *= c > 0 ? WV[i][h] / c : 0.5;
        }
        const rh = eqrHero * (1 + PLAYABILITY[h] * t.playScale);
        const a = raw * rh;
        const b = (1 - raw) * rOthers;
        const share = a + b > 0 ? a / (a + b) : raw;
        out[base + h] += prod[base + h] * (share * uWin + (1 - share) * uOthers);
      }
    }
  }
}

export function rootValues(out: Float64Array, n: number): number[] {
  const vals: number[] = [];
  for (let p = 0; p < n; p++) {
    let s = 0;
    for (let h = 0; h < N; h++) s += COMBOS[h] * out[p * N + h];
    vals.push(s / 1326);
  }
  return vals;
}

/** average best-response gain per player */
export function exploitabilityOf(ev: number[], br: number[]): number {
  let s = 0;
  for (let p = 0; p < ev.length; p++) s += Math.max(0, br[p] - ev[p]);
  return s / ev.length;
}

export function solve(tree: GameTree, onProgress?: (p: SolveProgress) => void, checkEvery = 50): SolveResult {
  const solver = new Solver(tree);
  const total = tree.config.iterations;
  let expl = NaN;
  const step = 10;
  while (solver.iterations < total) {
    solver.run(Math.min(step, total - solver.iterations));
    const it = solver.iterations;
    if (onProgress) {
      if (it % checkEvery === 0 || it === total) {
        expl = solver.exploitability();
        onProgress({ iteration: it, exploitability: expl });
      } else onProgress({ iteration: it });
    }
  }
  return finalize(solver, expl);
}

export function finalize(solver: Solver, expl?: number): SolveResult {
  const strategy = solver.averageStrategy();
  const evIcm = new Float32Array(strategy.length);
  const evChip = new Float32Array(strategy.length);
  const rootIcm = solver.evaluate('icm', evIcm);
  const rootChip = solver.evaluate('chip', evChip);
  const exploitability = expl !== undefined && !Number.isNaN(expl) ? expl : solver.exploitability();
  return { offsets: solver.offsets, strategy, evIcm, evChip, rootIcm, rootChip, exploitability, iterations: solver.iterations };
}
