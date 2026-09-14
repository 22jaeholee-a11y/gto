// Heads-up postflop DCFR over 1326 combos (compressed to each player's active range).
//
// Vectors are indexed by position in a player's active combo list. Card removal between the two
// players is exact: the opponent mass compatible with a hero combo (a, b) is
// total - cardSum[a] - cardSum[b] + reach[same combo].

import { BoardEvaluator } from '../evaluator';
import { COMBO_C1, COMBO_C2, NC } from './combos';
import type { PDecision, PNode, PostflopTree, PTerminal } from './tree';

const ALPHA = 1.5;
const GAMMA = 2;

type Util = 'icm' | 'chip';
type Pass = 'train' | 'ev' | 'br';

export interface PostflopResult {
  /** decision node ids of the solved street, in tree order */
  nodeIds: number[];
  /** per exported node: actions × 1326 average strategy (0 for combos outside the range) */
  strategy: Float32Array[];
  /** per exported node: actions × 1326 EV for the acting player's combo (NaN if unreachable) */
  evIcm: Float32Array[];
  evChip: Float32Array[];
  exploitability: number;
  iterations: number;
}

/**
 * Parallel turn solves: the coordinator owns the turn betting nodes; at chance nodes it hands the
 * reach vectors for every river card to workers, which own the river subtrees of their cards.
 */
export type PostflopRole = { role: 'all' } | { role: 'coordinator' } | { role: 'worker'; cards: number[] };

export interface ChanceItem {
  /** chanceNodeId * 64 + card */
  key: number;
  child: number;
  card: number;
  reachP: Float64Array;
  reachO: Float64Array;
}

export interface ChanceExecutor {
  run(p: 0 | 1, pass: Pass, util: Util, t: number, items: ChanceItem[]): Promise<Map<number, Float64Array>>;
}

export type { Pass as PostflopPass, Util as PostflopUtil };

interface BoardInfo {
  /** per player: active positions sorted by hand rank (combos blocked by the board excluded) */
  sorted: [Int32Array, Int32Array];
  /** per player: hand rank for each active position (-1 if blocked on this board) */
  rank: [Int32Array, Int32Array];
}

export class PostflopSolver {
  readonly tree: PostflopTree;
  readonly active: [Int32Array, Int32Array];
  /** position of a combo in each player's active list, -1 if absent */
  readonly pos: [Int32Array, Int32Array];
  readonly initial: [Float64Array, Float64Array];
  private offsets: Int32Array;
  private regrets: Float32Array;
  private stratSum: Float32Array;
  private boardInfo: Array<BoardInfo | null>;
  /**
   * Flop run-out equity E[i][j] = P(OOP active i beats IP active j) + tie/2, stored as a rank-K
   * factorization E ≈ Σ_k U[k][i] · B[k][j] so each equity leaf costs K·(n0 + n1) instead of n0·n1.
   */
  private eqU: Float64Array | null = null;
  private eqB: Float64Array | null = null;
  private eqRank = 0;
  private eqCoef = new Float64Array(64);
  private iteration = 0;
  private pass: Pass = 'train';
  private util: Util;
  private evStore: { icm: Float32Array[]; chip: Float32Array[] } | null = null;
  private evUtil: Util = 'icm';
  private pool: Array<{ reach: Float64Array; cfv: Float64Array; act: Float64Array; sigma: Float64Array; value: Float64Array }> = [];
  private cardSum = new Float64Array(52);
  private cardCum = new Float64Array(52);
  private tieCard = new Float64Array(52);

  readonly role: PostflopRole;
  private mode: 'normal' | 'collect' | 'apply' = 'normal';
  private items: ChanceItem[] = [];
  private results: Map<number, Float64Array> | null = null;

  constructor(tree: PostflopTree, ranges: [Float64Array, Float64Array], role: PostflopRole = { role: 'all' }) {
    this.tree = tree;
    this.role = role;
    this.util = tree.spot.icm.mode;
    const board = tree.boards[0];
    const blocked = new Uint8Array(52);
    for (const c of board) blocked[c] = 1;
    const act: Int32Array[] = [];
    const pos: Int32Array[] = [];
    const init: Float64Array[] = [];
    for (let p = 0; p < 2; p++) {
      const list: number[] = [];
      for (let k = 0; k < NC; k++) if (ranges[p][k] > 0 && !blocked[COMBO_C1[k]] && !blocked[COMBO_C2[k]]) list.push(k);
      const a = Int32Array.from(list);
      const ps = new Int32Array(NC).fill(-1);
      a.forEach((k, i) => (ps[k] = i));
      act.push(a);
      pos.push(ps);
      init.push(Float64Array.from(a, (k) => ranges[p][k]));
    }
    this.active = [act[0], act[1]];
    this.pos = [pos[0], pos[1]];
    this.initial = [init[0], init[1]];

    // river card owning each node (-1 for the street being solved)
    const cardOf = new Int16Array(tree.nodes.length).fill(-1);
    for (const nd of tree.nodes) {
      if (nd.kind !== 'chance') continue;
      for (const ch of nd.children) {
        const stack = [ch.child];
        while (stack.length) {
          const id = stack.pop()!;
          cardOf[id] = ch.card;
          const x = tree.nodes[id];
          if (x.kind === 'decision') for (const a of x.actions) stack.push(a.child);
        }
      }
    }
    const owned = (id: number) =>
      role.role === 'all' || (role.role === 'coordinator' ? cardOf[id] < 0 : cardOf[id] >= 0 && role.cards.includes(cardOf[id]));
    this.offsets = new Int32Array(tree.numDecisions).fill(-1);
    let off = 0;
    for (const nd of tree.nodes) {
      if (nd.kind !== 'decision' || !owned(nd.id)) continue;
      this.offsets[nd.dIndex] = off;
      off += nd.actions.length * this.active[nd.player].length;
    }
    this.regrets = new Float32Array(off);
    this.stratSum = new Float32Array(off);

    this.boardInfo = tree.boards.map(() => null);
    const needsShowdown = new Set<number>();
    let needsEquity = false;
    for (const nd of tree.nodes) {
      if (nd.kind !== 'terminal') continue;
      if (nd.tType === 'showdown' && owned(nd.id)) needsShowdown.add(nd.boardId);
      if (nd.tType === 'equity') needsEquity = true;
    }
    for (const b of needsShowdown) this.boardInfo[b] = this.rankBoard(tree.boards[b]);
    if (needsEquity) this.factorEquity(this.flopEquity(board));
  }

  get iterations() { return this.iteration; }

  private rankBoard(board: number[]): BoardInfo {
    const ev = new BoardEvaluator(board);
    const blocked = new Uint8Array(52);
    for (const c of board) blocked[c] = 1;
    const sorted: Int32Array[] = [];
    const ranks: Int32Array[] = [];
    for (let p = 0; p < 2; p++) {
      const a = this.active[p];
      const rank = new Int32Array(a.length).fill(-1);
      const list: number[] = [];
      for (let i = 0; i < a.length; i++) {
        const c1 = COMBO_C1[a[i]], c2 = COMBO_C2[a[i]];
        if (blocked[c1] || blocked[c2]) continue;
        rank[i] = ev.eval2(c1, c2);
        list.push(i);
      }
      list.sort((x, y) => rank[x] - rank[y]);
      sorted.push(Int32Array.from(list));
      ranks.push(rank);
    }
    return { sorted: [sorted[0], sorted[1]], rank: [ranks[0], ranks[1]] };
  }

  /**
   * Run-out equity of every OOP/IP active pair: every turn card, and RIVERS_PER_TURN evenly spaced
   * river cards per turn. Each pair is normalized by the number of sampled run-outs that avoid its
   * four hole cards (inclusion-exclusion over cards, since a run-out has two cards).
   */
  private flopEquity(board: number[]): Float32Array {
    const RIVERS_PER_TURN = 12;
    const [a0, a1] = this.active;
    const n0 = a0.length, n1 = a1.length;
    const E = new Float32Array(n0 * n1);
    const deck: number[] = [];
    for (let c = 0; c < 52; c++) if (!board.includes(c)) deck.push(c);
    const ev = new BoardEvaluator();
    const r0 = new Int32Array(n0);
    const r1 = new Int32Array(n1);
    const five = [board[0], board[1], board[2], 0, 0];
    const cnt1 = new Float64Array(52);
    const cnt2 = new Float64Array(52 * 52);
    let runouts = 0;
    for (let x = 0; x < deck.length; x++) {
      const t = deck[x];
      const rest = deck.filter((c) => c !== t);
      const step = rest.length / RIVERS_PER_TURN;
      for (let m = 0; m < RIVERS_PER_TURN; m++) {
        const r = rest[Math.floor(m * step + (x % 3) * step / 3) % rest.length];
        runouts++;
        cnt1[t]++; cnt1[r]++;
        cnt2[t * 52 + r]++; cnt2[r * 52 + t]++;
        five[3] = t; five[4] = r;
        ev.setBoard(five);
        for (let i = 0; i < n0; i++) {
          const c1 = COMBO_C1[a0[i]], c2 = COMBO_C2[a0[i]];
          r0[i] = c1 === t || c1 === r || c2 === t || c2 === r ? -1 : ev.eval2(c1, c2);
        }
        for (let j = 0; j < n1; j++) {
          const c1 = COMBO_C1[a1[j]], c2 = COMBO_C2[a1[j]];
          r1[j] = c1 === t || c1 === r || c2 === t || c2 === r ? -1 : ev.eval2(c1, c2);
        }
        for (let i = 0; i < n0; i++) {
          const ri = r0[i];
          if (ri < 0) continue;
          const base = i * n1;
          for (let j = 0; j < n1; j++) {
            const rj = r1[j];
            if (rj < 0) continue;
            E[base + j] += ri > rj ? 1 : ri === rj ? 0.5 : 0;
          }
        }
      }
    }
    for (let i = 0; i < n0; i++) {
      const c1 = COMBO_C1[a0[i]], c2 = COMBO_C2[a0[i]];
      const base = i * n1;
      for (let j = 0; j < n1; j++) {
        const d1 = COMBO_C1[a1[j]], d2 = COMBO_C2[a1[j]];
        if (c1 === d1 || c1 === d2 || c2 === d1 || c2 === d2) { E[base + j] = 0; continue; }
        const cards = [c1, c2, d1, d2];
        let valid = runouts;
        for (let u = 0; u < 4; u++) {
          valid -= cnt1[cards[u]];
          for (let v = u + 1; v < 4; v++) valid += cnt2[cards[u] * 52 + cards[v]];
        }
        E[base + j] = valid > 0 ? E[base + j] / valid : 0.5;
      }
    }
    return E;
  }

  /** rank-K factorization E ≈ U·B via block power iteration (K = 64, or exact when small) */
  private factorEquity(E: Float32Array): void {
    const n0 = this.active[0].length, n1 = this.active[1].length;
    const K = Math.min(64, n0, n1);
    const mul = (v: Float64Array, out: Float64Array) => {
      for (let i = 0; i < n0; i++) {
        const base = i * n1;
        let w = 0;
        for (let j = 0; j < n1; j++) w += E[base + j] * v[j];
        out[i] = w;
      }
    };
    const mulT = (x: Float64Array, out: Float64Array) => {
      out.fill(0);
      for (let i = 0; i < n0; i++) {
        const xi = x[i];
        if (xi === 0) continue;
        const base = i * n1;
        for (let j = 0; j < n1; j++) out[j] += E[base + j] * xi;
      }
    };
    const orthonormalize = (vs: Float64Array[]) => {
      for (let a = 0; a < vs.length; a++) {
        for (let b = 0; b < a; b++) {
          let d = 0;
          const va = vs[a], vb = vs[b];
          for (let t = 0; t < va.length; t++) d += va[t] * vb[t];
          for (let t = 0; t < va.length; t++) va[t] -= d * vb[t];
        }
        let nn = 0;
        for (const x of vs[a]) nn += x * x;
        nn = Math.sqrt(nn) || 1;
        for (let t = 0; t < vs[a].length; t++) vs[a][t] /= nn;
      }
    };
    let seed = 12345;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
    let V = Array.from({ length: K }, () => Float64Array.from({ length: n1 }, rand));
    let U = Array.from({ length: K }, () => new Float64Array(n0));
    orthonormalize(V);
    for (let it = 0; it < 4; it++) {
      V.forEach((v, k) => mul(v, U[k]));
      orthonormalize(U);
      U.forEach((u, k) => mulT(u, V[k]));
      orthonormalize(V);
    }
    V.forEach((v, k) => mul(v, U[k]));
    orthonormalize(U);
    const B = Array.from({ length: K }, () => new Float64Array(n1));
    U.forEach((u, k) => mulT(u, B[k]));
    this.eqRank = K;
    this.eqU = new Float64Array(K * n0);
    this.eqB = new Float64Array(K * n1);
    for (let k = 0; k < K; k++) {
      this.eqU.set(U[k], k * n0);
      this.eqB.set(B[k], k * n1);
    }
    if (this.eqCoef.length < K) this.eqCoef = new Float64Array(K);
    V = []; U = [];
  }

  private buffers(depth: number, p: number) {
    const size = Math.max(this.active[0].length, this.active[1].length);
    while (this.pool.length <= depth) {
      this.pool.push({
        reach: new Float64Array(size),
        cfv: new Float64Array(size),
        act: new Float64Array(8 * size),
        sigma: new Float64Array(8 * size),
        value: new Float64Array(size),
      });
    }
    void p;
    return this.pool[depth];
  }

  run(count: number): void {
    for (let k = 0; k < count; k++) {
      this.iteration++;
      for (const p of [0, 1] as const) this.walkRootSync(p, 'train', this.tree.spot.icm.mode);
    }
  }

  async runAsync(count: number, exec: ChanceExecutor): Promise<void> {
    for (let k = 0; k < count; k++) {
      this.iteration++;
      for (const p of [0, 1] as const) await this.walkRoot(p, 'train', this.tree.spot.icm.mode, exec);
    }
  }

  private walkRootSync(p: 0 | 1, pass: Pass, util: Util): Float64Array {
    this.pass = pass;
    this.util = util;
    const out = new Float64Array(this.active[p].length);
    this.walk(0, 0, p, this.initial[p].slice(), this.initial[1 - p].slice(), out);
    return out;
  }

  /** one traversal; with an executor, chance children are evaluated remotely (collect → run → apply) */
  private async walkRoot(p: 0 | 1, pass: Pass, util: Util, exec: ChanceExecutor | null): Promise<Float64Array> {
    if (!exec) return this.walkRootSync(p, pass, util);
    this.mode = 'collect';
    this.items = [];
    try {
      this.walkRootSync(p, pass, util);
    } finally {
      this.mode = 'normal';
    }
    const items = this.items;
    this.items = [];
    this.results = items.length ? await exec.run(p, pass, util, this.iteration, items) : new Map();
    this.mode = 'apply';
    try {
      return this.walkRootSync(p, pass, util);
    } finally {
      this.mode = 'normal';
      this.results = null;
    }
  }

  /** evaluate delegated river subtrees (worker role) */
  runItems(p: 0 | 1, pass: Pass, util: Util, t: number, items: Array<Pick<ChanceItem, 'child' | 'reachP' | 'reachO'>>): Float64Array[] {
    this.iteration = t;
    this.pass = pass;
    this.util = util;
    return items.map((it) => {
      const out = new Float64Array(this.active[p].length);
      this.walk(it.child, 0, p, it.reachP, it.reachO, out);
      return out;
    });
  }

  private normalizedValue(p: 0 | 1, out: Float64Array): number {
    const n = this.active[p].length;
    const opp = this.initial[1 - p];
    const oa = this.active[1 - p];
    let total = 0;
    this.cardSum.fill(0);
    for (let j = 0; j < oa.length; j++) {
      total += opp[j];
      this.cardSum[COMBO_C1[oa[j]]] += opp[j];
      this.cardSum[COMBO_C2[oa[j]]] += opp[j];
    }
    let num = 0, den = 0;
    const ha = this.active[p];
    for (let i = 0; i < n; i++) {
      const k = ha[i];
      const same = this.pos[1 - p][k];
      const m = total - this.cardSum[COMBO_C1[k]] - this.cardSum[COMBO_C2[k]] + (same >= 0 ? opp[same] : 0);
      num += this.initial[p][i] * out[i];
      den += this.initial[p][i] * m;
    }
    return den > 0 ? num / den : 0;
  }

  exploitability(): number {
    const util = this.tree.spot.icm.mode;
    let s = 0;
    for (const p of [0, 1] as const)
      s += Math.max(0, this.normalizedValue(p, this.walkRootSync(p, 'br', util)) - this.normalizedValue(p, this.walkRootSync(p, 'ev', util)));
    return s / 2;
  }

  async exploitabilityAsync(exec: ChanceExecutor | null): Promise<number> {
    const util = this.tree.spot.icm.mode;
    let s = 0;
    for (const p of [0, 1] as const) {
      const br = this.normalizedValue(p, await this.walkRoot(p, 'br', util, exec));
      const ev = this.normalizedValue(p, await this.walkRoot(p, 'ev', util, exec));
      s += Math.max(0, br - ev);
    }
    return s / 2;
  }

  private strategyAt(nd: PDecision, sigma: Float64Array, average: boolean) {
    const A = nd.actions.length;
    const n = this.active[nd.player].length;
    const off = this.offsets[nd.dIndex];
    const src = average ? this.stratSum : this.regrets;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let a = 0; a < A; a++) { const v = src[off + a * n + i]; if (v > 0) sum += v; }
      for (let a = 0; a < A; a++) {
        const v = src[off + a * n + i];
        sigma[a * n + i] = sum > 0 ? (v > 0 ? v / sum : 0) : 1 / A;
      }
    }
  }

  /**
   * Counterfactual values for traverser p (written to out, length n_p).
   * reachP: p's own reach (for averaging), reachO: opponent reach.
   */
  private walk(id: number, depth: number, p: 0 | 1, reachP: Float64Array, reachO: Float64Array, out: Float64Array): void {
    const nd = this.tree.nodes[id];
    const np = this.active[p].length;
    if (nd.kind === 'terminal') {
      if (this.mode === 'collect') out.fill(0, 0, np);
      else this.terminal(nd, p, reachO, out);
      return;
    }
    if (nd.kind === 'chance') { this.chance(nd, depth, p, reachP, reachO, out); return; }

    const buf = this.pool[depth] ?? this.buffers(depth, p);
    const A = nd.actions.length;
    const q = nd.player;
    const nq = this.active[q].length;
    const sigma = buf.sigma;
    this.strategyAt(nd, sigma, this.pass !== 'train');

    if (q !== p) {
      out.fill(0, 0, np);
      const child = this.childBuffers(depth);
      for (let a = 0; a < A; a++) {
        const r = child.reach;
        for (let j = 0; j < nq; j++) r[j] = reachO[j] * sigma[a * nq + j];
        this.walk(nd.actions[a].child, depth + 1, p, reachP, r.subarray(0, nq), child.cfv.subarray(0, np));
        for (let i = 0; i < np; i++) out[i] += child.cfv[i];
      }
      return;
    }

    const act = buf.act;
    const child = this.childBuffers(depth);
    for (let a = 0; a < A; a++) {
      const r = child.reach;
      for (let i = 0; i < np; i++) r[i] = reachP[i] * sigma[a * np + i];
      const cfv = act.subarray(a * np, (a + 1) * np);
      this.walk(nd.actions[a].child, depth + 1, p, r.subarray(0, np), reachO, cfv);
    }

    if (this.pass === 'br') {
      for (let i = 0; i < np; i++) {
        let best = -Infinity;
        for (let a = 0; a < A; a++) if (act[a * np + i] > best) best = act[a * np + i];
        out[i] = best;
      }
      return;
    }
    for (let i = 0; i < np; i++) {
      let v = 0;
      for (let a = 0; a < A; a++) v += sigma[a * np + i] * act[a * np + i];
      out[i] = v;
    }

    if (this.mode === 'collect') return;
    const off = this.offsets[nd.dIndex];
    if (this.pass === 'train') {
      const t = this.iteration;
      const pw = Math.pow(t, ALPHA);
      const posD = pw / (pw + 1);
      const sD = Math.pow(t / (t + 1), GAMMA);
      for (let a = 0; a < A; a++) {
        const base = off + a * np;
        for (let i = 0; i < np; i++) {
          const rg = this.regrets[base + i];
          this.regrets[base + i] = rg * (rg > 0 ? posD : 0.5) + (act[a * np + i] - out[i]);
          this.stratSum[base + i] = this.stratSum[base + i] * sD + sigma[a * np + i] * reachP[i];
        }
      }
    } else if (this.pass === 'ev' && this.evStore && nd.root) {
      const store = this.evStore[this.evUtil][this.exportIndex.get(nd.id)!];
      const mass = this.compatMass(p, reachO);
      const ha = this.active[p];
      store.fill(NaN);
      for (let a = 0; a < A; a++)
        for (let i = 0; i < np; i++) store[a * NC + ha[i]] = mass[i] > 1e-12 ? act[a * np + i] / mass[i] : NaN;
    }
  }

  private childPool: Array<{ reach: Float64Array; cfv: Float64Array }> = [];
  private childBuffers(depth: number) {
    const size = Math.max(this.active[0].length, this.active[1].length);
    while (this.childPool.length <= depth) this.childPool.push({ reach: new Float64Array(size), cfv: new Float64Array(size) });
    return this.childPool[depth];
  }

  /** opponent mass compatible with each hero combo */
  private compatMass(p: 0 | 1, reachO: Float64Array): Float64Array {
    const o = (1 - p) as 0 | 1;
    const oa = this.active[o];
    const ha = this.active[p];
    const cs = this.cardSum;
    cs.fill(0);
    let total = 0;
    for (let j = 0; j < oa.length; j++) {
      const r = reachO[j];
      if (r === 0) continue;
      total += r;
      cs[COMBO_C1[oa[j]]] += r;
      cs[COMBO_C2[oa[j]]] += r;
    }
    const m = new Float64Array(ha.length);
    for (let i = 0; i < ha.length; i++) {
      const k = ha[i];
      const same = this.pos[o][k];
      m[i] = total - cs[COMBO_C1[k]] - cs[COMBO_C2[k]] + (same >= 0 ? reachO[same] : 0);
    }
    return m;
  }

  private chance(nd: Extract<PNode, { kind: 'chance' }>, depth: number, p: 0 | 1, reachP: Float64Array, reachO: Float64Array, out: Float64Array) {
    const np = this.active[p].length;
    const o = (1 - p) as 0 | 1;
    const no = this.active[o].length;
    const ha = this.active[p];
    const oa = this.active[o];
    out.fill(0, 0, np);
    const child = this.childBuffers(depth);
    const rp = new Float64Array(np);
    // every compatible hero/opponent pair leaves the same number of river cards
    const weight = 1 / (52 - this.tree.boards[0].length - 4);
    if (this.mode === 'collect') {
      for (const ch of nd.children) {
        const c = ch.card;
        const ro = new Float64Array(no);
        const rq = new Float64Array(np);
        for (let j = 0; j < no; j++) ro[j] = COMBO_C1[oa[j]] === c || COMBO_C2[oa[j]] === c ? 0 : reachO[j];
        for (let i = 0; i < np; i++) rq[i] = COMBO_C1[ha[i]] === c || COMBO_C2[ha[i]] === c ? 0 : reachP[i];
        this.items.push({ key: nd.id * 64 + c, child: ch.child, card: c, reachP: rq, reachO: ro });
      }
      return;
    }
    if (this.mode === 'apply') {
      for (const ch of nd.children) {
        const c = ch.card;
        const cfv = this.results!.get(nd.id * 64 + c)!;
        for (let i = 0; i < np; i++) if (COMBO_C1[ha[i]] !== c && COMBO_C2[ha[i]] !== c) out[i] += cfv[i] * weight;
      }
      return;
    }
    for (const ch of nd.children) {
      const c = ch.card;
      for (let j = 0; j < no; j++) child.reach[j] = COMBO_C1[oa[j]] === c || COMBO_C2[oa[j]] === c ? 0 : reachO[j];
      for (let i = 0; i < np; i++) rp[i] = COMBO_C1[ha[i]] === c || COMBO_C2[ha[i]] === c ? 0 : reachP[i];
      const cfv = child.cfv.subarray(0, np);
      this.walk(ch.child, depth + 1, p, rp, child.reach.subarray(0, no), cfv);
      // hero combos holding the river card can't reach this branch
      for (let i = 0; i < np; i++) if (COMBO_C1[ha[i]] !== c && COMBO_C2[ha[i]] !== c) out[i] += cfv[i] * weight;
    }
  }

  private terminal(t: PTerminal, p: 0 | 1, reachO: Float64Array, out: Float64Array) {
    const U = this.util === 'icm' ? t.utilIcm : t.utilChip;
    const o = (1 - p) as 0 | 1;
    const ha = this.active[p];
    const oa = this.active[o];
    const np = ha.length;
    const cs = this.cardSum;
    cs.fill(0);
    let total = 0;
    for (let j = 0; j < oa.length; j++) {
      const r = reachO[j];
      if (r === 0) continue;
      total += r;
      cs[COMBO_C1[oa[j]]] += r;
      cs[COMBO_C2[oa[j]]] += r;
    }
    if (total === 0) { out.fill(0, 0, np); return; }
    const massOf = (i: number) => {
      const k = ha[i];
      const same = this.pos[o][k];
      return total - cs[COMBO_C1[k]] - cs[COMBO_C2[k]] + (same >= 0 ? reachO[same] : 0);
    };

    if (t.tType === 'fold') {
      const u = U[p];
      for (let i = 0; i < np; i++) out[i] = u * massOf(i);
      return;
    }
    const uWin = U[p === 0 ? 0 : 3];
    const uLose = U[p === 0 ? 2 : 1];
    const uTie = U[4 + p];

    if (t.tType === 'equity') {
      const K = this.eqRank;
      const U = this.eqU!, B = this.eqB!;
      const n0 = this.active[0].length, n1 = this.active[1].length;
      const coef = this.eqCoef;
      if (p === 0) {
        // w = E·r1 = U · (B·r1)
        for (let k = 0; k < K; k++) {
          let d = 0;
          const base = k * n1;
          for (let j = 0; j < n1; j++) d += B[base + j] * reachO[j];
          coef[k] = d;
        }
        for (let i = 0; i < np; i++) {
          let w = 0;
          for (let k = 0; k < K; k++) w += U[k * n0 + i] * coef[k];
          const m = massOf(i);
          w = Math.min(m, Math.max(0, w));
          out[i] = uLose * m + (uWin - uLose) * w;
        }
      } else {
        // IP equity vs OOP range = compatible mass - E^T·r0, with E^T·r0 = B^T · (U^T·r0)
        for (let k = 0; k < K; k++) {
          let d = 0;
          const base = k * n0;
          for (let i = 0; i < n0; i++) d += U[base + i] * reachO[i];
          coef[k] = d;
        }
        for (let j = 0; j < np; j++) {
          let lose = 0;
          for (let k = 0; k < K; k++) lose += B[k * n1 + j] * coef[k];
          const m = massOf(j);
          const w = Math.min(m, Math.max(0, m - lose));
          out[j] = uLose * m + (uWin - uLose) * w;
        }
      }
      return;
    }

    // showdown: sweep both players' combos in rank order
    const info = this.boardInfo[t.boardId]!;
    const hs = info.sorted[p], hr = info.rank[p];
    const os = info.sorted[o], orank = info.rank[o];
    const cum = this.cardCum;
    const tieCard = this.tieCard;
    cum.fill(0);
    out.fill(0, 0, np);
    let cumTotal = 0;
    let j = 0;
    for (let g = 0; g < hs.length; ) {
      const R = hr[hs[g]];
      while (j < os.length && orank[os[j]] < R) {
        const r = reachO[os[j]];
        if (r !== 0) {
          cumTotal += r;
          cum[COMBO_C1[oa[os[j]]]] += r;
          cum[COMBO_C2[oa[os[j]]]] += r;
        }
        j++;
      }
      let k = j, tieTotal = 0;
      while (k < os.length && orank[os[k]] === R) {
        const r = reachO[os[k]];
        if (r !== 0) {
          tieTotal += r;
          tieCard[COMBO_C1[oa[os[k]]]] += r;
          tieCard[COMBO_C2[oa[os[k]]]] += r;
        }
        k++;
      }
      let ge = g;
      while (ge < hs.length && hr[hs[ge]] === R) {
        const i = hs[ge];
        const combo = ha[i];
        const a = COMBO_C1[combo], b = COMBO_C2[combo];
        const same = this.pos[o][combo];
        const sameReach = same >= 0 && orank[same] === R ? reachO[same] : 0;
        const win = cumTotal - cum[a] - cum[b];
        const tie = tieTotal - tieCard[a] - tieCard[b] + sameReach;
        const m = massOf(i);
        out[i] = uLose * m + (uWin - uLose) * win + (uTie - uLose) * tie;
        ge++;
      }
      for (let x = j; x < k; x++) {
        tieCard[COMBO_C1[oa[os[x]]]] = 0;
        tieCard[COMBO_C2[oa[os[x]]]] = 0;
      }
      g = ge;
    }
  }

  private exportIndex = new Map<number, number>();

  finalize(): PostflopResult {
    return this.finalizeWith(
      (p, pass, util) => this.walkRootSync(p, pass, util),
      () => this.exploitability(),
    );
  }

  async finalizeAsync(exec: ChanceExecutor | null): Promise<PostflopResult> {
    const exploitability = await this.exploitabilityAsync(exec);
    const outs: Array<() => Promise<void>> = [];
    const nodeIds = this.exportNodes();
    const res = this.prepareExport(nodeIds);
    for (const util of ['icm', 'chip'] as const) {
      for (const p of [0, 1] as const) {
        outs.push(async () => {
          this.evUtil = util;
          await this.walkRoot(p, 'ev', util, exec);
        });
      }
    }
    for (const run of outs) await run();
    this.evStore = null;
    return { ...res, exploitability };
  }

  private exportNodes(): number[] {
    const nodeIds: number[] = [];
    for (const nd of this.tree.nodes) if (nd.kind === 'decision' && nd.root) nodeIds.push(nd.id);
    this.exportIndex = new Map(nodeIds.map((id, i) => [id, i]));
    return nodeIds;
  }

  private prepareExport(nodeIds: number[]): Omit<PostflopResult, 'exploitability'> {
    const strategy: Float32Array[] = [];
    for (const id of nodeIds) {
      const nd = this.tree.nodes[id] as PDecision;
      const A = nd.actions.length;
      const n = this.active[nd.player].length;
      const sigma = new Float64Array(A * n);
      this.strategyAt(nd, sigma, true);
      const full = new Float32Array(A * NC);
      const ha = this.active[nd.player];
      for (let a = 0; a < A; a++) for (let i = 0; i < n; i++) full[a * NC + ha[i]] = sigma[a * n + i];
      strategy.push(full);
    }
    const alloc = () => nodeIds.map((id) => new Float32Array((this.tree.nodes[id] as PDecision).actions.length * NC).fill(NaN));
    this.evStore = { icm: alloc(), chip: alloc() };
    return { nodeIds, strategy, evIcm: this.evStore.icm, evChip: this.evStore.chip, iterations: this.iteration };
  }

  private finalizeWith(walk: (p: 0 | 1, pass: Pass, util: Util) => Float64Array, expl: () => number): PostflopResult {
    const exploitability = expl();
    const res = this.prepareExport(this.exportNodes());
    for (const util of ['icm', 'chip'] as const) {
      this.evUtil = util;
      for (const p of [0, 1] as const) walk(p, 'ev', util);
    }
    this.evStore = null;
    return { ...res, exploitability };
  }

}

