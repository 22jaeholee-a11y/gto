// One training hand: real cards, bots sampling the solved strategies, hero decisions reviewed
// against solver frequencies and EVs on every street.

import { COMBOS, NUM_CLASSES } from '../cards';
import { seatNames } from '../config';
import { BoardEvaluator, evaluate7 } from '../evaluator';
import { icmEquity } from '../icm';
import { payoutWithTies } from '../reference';
import type { SolveResult } from '../solver';
import { actionLabel, postflopRank, type DecisionNode, type GameTree, type TerminalNode } from '../tree';
import { COMBO_C1, COMBO_C2, COMBO_CLASS, COMBO_INDEX, NC, cardText } from '../postflop/combos';
import type { PostflopResult } from '../postflop/solver';
import {
  buildPostflopTree, DEFAULT_POSTFLOP_SIZING, postflopActionLabel,
  type PDecision, type PostflopSpot, type PostflopTree, type Street as PStreet,
} from '../postflop/tree';
import type { Rand, Scenario } from './scenario';
import { explainMultiway, explainPostflop, explainPreflop, summarizeHand, type Explanation, type HandSummary } from './coach';

const N = NUM_CLASSES;

export type Street = 'preflop' | 'flop' | 'turn' | 'river';

export interface SolvedScenario {
  scenario: Scenario;
  tree: GameTree;
  result: SolveResult;
}

export interface PostflopService {
  solve(spot: PostflopSpot, ranges: [Float64Array, Float64Array], onProgress?: (fraction: number) => void): Promise<PostflopResult>;
}

export type Verdict = 'best' | 'good' | 'inaccuracy' | 'mistake' | 'blunder' | 'info';

export interface ReviewOption {
  label: string;
  /** solver frequency for the hero's hand, null when not solver-based */
  freq: number | null;
  evIcm: number | null;
  evChip: number | null;
}

export interface ActionReview {
  street: Street;
  hand: string;
  chosen: number;
  best: number;
  options: ReviewOption[];
  primary: 'icm' | 'chip';
  /** EV lost versus the best option, in the primary unit (%p or bb) */
  loss: number;
  /** loss converted to big blinds for grading */
  lossBB: number;
  verdict: Verdict;
  approximate: boolean;
  notes: string[];
  /** the hero's whole range at this decision (solver spots only) */
  range?: RangeReview;
  /** why the best action is best, in words */
  explanation?: Explanation;
}

/**
 * Range-wide view of a decision, aggregated to the 169 hand classes.
 * Arrays are [class] or [class * actions + action]; EVs are NaN where a class has no weight.
 */
export interface RangeReview {
  actions: string[];
  heroClass: number;
  /** share of each class's combos still in the range (0..1) */
  weight: Float32Array;
  freq: Float32Array;
  evIcm: Float32Array;
  evChip: Float32Array;
  /** per action over the whole range: frequency and average EV of taking that action */
  summary: Array<{ freq: number; evIcm: number | null; evChip: number | null }>;
  /** EV of the range playing the solver strategy */
  valueIcm: number | null;
  valueChip: number | null;
  combos: number;
}

/** Builds a RangeReview from per-unit weights (classes or combos) mapped onto classes. */
function buildRangeReview(
  actions: string[],
  heroClass: number,
  units: number,
  classOf: (u: number) => number,
  combosOf: (u: number) => number,
  weightOf: (u: number) => number,
  freqOf: (u: number, a: number) => number,
  evIcmOf: (u: number, a: number) => number,
  evChipOf: (u: number, a: number) => number,
  classCapacity: (c: number) => number,
): RangeReview {
  const A = actions.length;
  const wsum = new Float64Array(N);
  const freq = new Float64Array(N * A);
  const icm = new Float64Array(N * A), icmW = new Float64Array(N * A);
  const chip = new Float64Array(N * A), chipW = new Float64Array(N * A);
  const sum = actions.map(() => ({ f: 0, icm: 0, icmW: 0, chip: 0, chipW: 0 }));
  let total = 0, vIcm = 0, vIcmW = 0, vChip = 0, vChipW = 0, combos = 0;
  for (let u = 0; u < units; u++) {
    const w0 = weightOf(u);
    if (!(w0 > 0)) continue;
    const c = classOf(u);
    const w = w0 * combosOf(u);
    wsum[c] += w;
    total += w;
    combos += w;
    let nodeIcm = 0, nodeChip = 0, okIcm = true, okChip = true;
    for (let a = 0; a < A; a++) {
      const fr = freqOf(u, a);
      freq[c * A + a] += w * fr;
      sum[a].f += w * fr;
      const ei = evIcmOf(u, a), ec = evChipOf(u, a);
      if (Number.isFinite(ei)) { icm[c * A + a] += w * ei; icmW[c * A + a] += w; sum[a].icm += w * ei; sum[a].icmW += w; nodeIcm += fr * ei; } else okIcm = false;
      if (Number.isFinite(ec)) { chip[c * A + a] += w * ec; chipW[c * A + a] += w; sum[a].chip += w * ec; sum[a].chipW += w; nodeChip += fr * ec; } else okChip = false;
    }
    if (okIcm) { vIcm += w * nodeIcm; vIcmW += w; }
    if (okChip) { vChip += w * nodeChip; vChipW += w; }
  }
  const weight = new Float32Array(N);
  const outFreq = new Float32Array(N * A);
  const outIcm = new Float32Array(N * A).fill(NaN);
  const outChip = new Float32Array(N * A).fill(NaN);
  for (let c = 0; c < N; c++) {
    const cap = classCapacity(c);
    weight[c] = cap > 0 ? Math.min(1, wsum[c] / cap) : 0;
    for (let a = 0; a < A; a++) {
      const i = c * A + a;
      outFreq[i] = wsum[c] > 0 ? freq[i] / wsum[c] : 0;
      if (icmW[i] > 0) outIcm[i] = icm[i] / icmW[i];
      if (chipW[i] > 0) outChip[i] = chip[i] / chipW[i];
    }
  }
  return {
    actions,
    heroClass,
    weight,
    freq: outFreq,
    evIcm: outIcm,
    evChip: outChip,
    summary: sum.map((x) => ({
      freq: total > 0 ? x.f / total : 0,
      evIcm: x.icmW > 0 ? x.icm / x.icmW : null,
      evChip: x.chipW > 0 ? x.chip / x.chipW : null,
    })),
    valueIcm: vIcmW > 0 ? vIcm / vIcmW : null,
    valueChip: vChipW > 0 ? vChip / vChipW : null,
    combos,
  };
}

export interface LogEntry {
  street: Street;
  seat: number;
  text: string;
  review?: ActionReview;
}

export interface Pending {
  street: Street;
  options: string[];
  toCall: number;
}

export interface HandResult {
  chip: number;
  icm: number;
  text: string;
  shown: Array<{ seat: number; cards: [number, number]; hand: string }>;
  summary?: HandSummary;
}

export interface HandView {
  scenarioLabel: string;
  scenario: Scenario;
  seatNames: string[];
  heroSeat: number;
  heroCards: [number, number];
  street: Street;
  board: number[];
  pot: number;
  stacks: number[];
  bets: number[];
  folded: boolean[];
  allin: boolean[];
  button: number;
  status: 'running' | 'hero' | 'solving' | 'done';
  solvingStreet?: Street;
  solveProgress: number;
  pending: Pending | null;
  log: LogEntry[];
  lastReview: ActionReview | null;
  result: HandResult | null;
  mode: 'icm' | 'chip';
}

const HAND_NAMES = ['하이카드', '원페어', '투페어', '트리플', '스트레이트', '플러시', '풀하우스', '포카드', '스트레이트 플러시'];
export function handName(score: number): string {
  return HAND_NAMES[Math.floor(score / (1 << 20))] ?? '';
}

export class TrainingHand {
  private sc: SolvedScenario;
  private rand: Rand;
  private service: PostflopService;
  private listeners = new Set<() => void>();
  private n: number;
  private startStacks: number[];
  private ante: number[];
  private payouts: number[];
  private totalChips: number;
  readonly heroSeat: number;
  private holes: Array<[number, number]> = [];
  private deck: number[] = [];

  private v: HandView;
  private preNode = 0;
  private preTrail: Array<{ node: DecisionNode; action: number }> = [];
  private pf: PostflopState | null = null;
  private mw: MultiwayState | null = null;

  constructor(sc: SolvedScenario, rand: Rand, service: PostflopService, heroSeat?: number) {
    this.sc = sc;
    this.rand = rand;
    this.service = service;
    const cfg = sc.tree.config;
    this.n = cfg.stacks.length;
    this.startStacks = cfg.stacks.slice();
    this.ante = this.startStacks.map((s, i) => (i === this.n - 1 ? Math.min(cfg.ante, s) : 0));
    const payTotal = cfg.payouts.reduce((a, b) => a + b, 0) || 1;
    this.payouts = cfg.payouts.map((p) => p / payTotal);
    this.totalChips = this.startStacks.reduce((a, b) => a + b, 0);
    this.heroSeat = heroSeat ?? Math.floor(rand() * this.n);

    const cards = Array.from({ length: 52 }, (_, i) => i);
    for (let i = 51; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    for (let s = 0; s < this.n; s++) this.holes.push([cards.pop()!, cards.pop()!]);
    this.deck = cards;

    const root = sc.tree.nodes[0] as DecisionNode;
    this.v = {
      scenarioLabel: sc.scenario.label,
      scenario: sc.scenario,
      seatNames: seatNames(this.n),
      heroSeat: this.heroSeat,
      heroCards: this.holes[this.heroSeat],
      street: 'preflop',
      board: [],
      pot: root.pot,
      stacks: root.behind.slice(),
      bets: root.contrib.slice(),
      folded: root.folded.slice(),
      allin: root.allin.slice(),
      button: this.n === 2 ? 0 : this.n - 3,
      status: 'running',
      solveProgress: 0,
      pending: null,
      log: [],
      lastReview: null,
      result: null,
      mode: cfg.mode,
    };
  }

  get view(): HandView { return this.v; }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(patch: Partial<HandView> = {}) {
    this.v = { ...this.v, ...patch };
    for (const cb of this.listeners) cb();
  }

  private classOf(seat: number): number {
    const [a, b] = this.holes[seat];
    return COMBO_CLASS[COMBO_INDEX[a * 52 + b]];
  }

  private comboOf(seat: number): number {
    const [a, b] = this.holes[seat];
    return COMBO_INDEX[a * 52 + b];
  }

  private handText(seat: number): string {
    const [a, b] = this.holes[seat];
    return a >= b ? cardText(a) + cardText(b) : cardText(b) + cardText(a);
  }

  private sample(weights: ArrayLike<number>): number {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += Math.max(0, weights[i]);
    let x = this.rand() * total;
    for (let i = 0; i < weights.length; i++) {
      x -= Math.max(0, weights[i]);
      if (x <= 0) return i;
    }
    return weights.length - 1;
  }

  async begin(): Promise<void> {
    this.log(this.heroSeat, `${this.v.seatNames[this.heroSeat]} (히어로) ${this.handText(this.heroSeat)}`, 'preflop');
    await this.runPreflop();
  }

  private log(seat: number, text: string, street: Street, review?: ActionReview) {
    this.v = { ...this.v, log: [...this.v.log, { street, seat, text, review }] };
  }

  // ---------------------------------------------------------------- preflop

  private preflopFreqs(nd: DecisionNode, cls: number): number[] {
    const off = this.sc.result.offsets[nd.dIndex];
    return nd.actions.map((_, a) => this.sc.result.strategy[off + a * N + cls]);
  }

  private async runPreflop() {
    const tree = this.sc.tree;
    for (;;) {
      const nd = tree.nodes[this.preNode];
      if (nd.kind === 'terminal') { await this.preflopTerminal(nd); return; }
      this.syncPreflopTable(nd);
      if (nd.player === this.heroSeat) {
        this.emit({
          status: 'hero',
          pending: { street: 'preflop', options: nd.actions.map((a) => actionLabel(a, nd)), toCall: Math.max(0, nd.bet - nd.contrib[nd.player]) },
        });
        return;
      }
      const a = this.sample(this.preflopFreqs(nd, this.classOf(nd.player)));
      this.log(nd.player, `${this.v.seatNames[nd.player]} ${actionLabel(nd.actions[a], nd)}`, 'preflop');
      this.preTrail.push({ node: nd, action: a });
      this.preNode = nd.actions[a].child;
    }
  }

  private syncPreflopTable(nd: DecisionNode | TerminalNode) {
    this.v = { ...this.v, pot: nd.pot, stacks: nd.behind.slice(), bets: nd.contrib.slice(), folded: nd.folded.slice(), allin: nd.allin.slice() };
  }

  private grade(lossPrimary: number, primary: 'icm' | 'chip', freq: number | null): { lossBB: number; verdict: Verdict } {
    // convert %p of the prize pool to big blinds using the average chip value of 1%p
    const lossBB = primary === 'icm' ? (lossPrimary * this.totalChips) / 100 : lossPrimary;
    let verdict: Verdict;
    if (lossBB <= 0.05) verdict = freq !== null && freq < 0.5 && lossBB > 1e-6 ? 'good' : 'best';
    else if (freq !== null && freq >= 0.1 && lossBB <= 0.15) verdict = 'good';
    else if (lossBB <= 0.3) verdict = 'inaccuracy';
    else if (lossBB <= 1.5) verdict = 'mistake';
    else verdict = 'blunder';
    return { lossBB, verdict };
  }

  private rarePreflopNote(): string | null {
    const res = this.sc.result;
    for (let i = 0; i < this.preTrail.length; i++) {
      const { node, action } = this.preTrail[i];
      if (node.player === this.heroSeat) continue;
      const reach = new Float64Array(N).fill(1);
      for (const st of this.preTrail.slice(0, i)) {
        if (st.node.player !== node.player) continue;
        const off = res.offsets[st.node.dIndex] + st.action * N;
        for (let h = 0; h < N; h++) reach[h] *= res.strategy[off + h];
      }
      let num = 0, den = 0;
      const off = res.offsets[node.dIndex] + action * N;
      for (let h = 0; h < N; h++) { const w = COMBOS[h] * reach[h]; den += w; num += w * res.strategy[off + h]; }
      if (den > 0 && num / den < 0.001) return `${this.v.seatNames[node.player]}의 ${actionLabel(node.actions[action], node)}은 균형 전략에서 거의 나오지 않는 라인이라 EV 신뢰도가 낮습니다.`;
    }
    return null;
  }

  async act(option: number): Promise<void> {
    if (this.v.status !== 'hero') return;
    if (this.pf) return this.actPostflop(option);
    if (this.mw) return this.actMultiway(option);
    const nd = this.sc.tree.nodes[this.preNode] as DecisionNode;
    const res = this.sc.result;
    const cls = this.classOf(this.heroSeat);
    const off = res.offsets[nd.dIndex];
    const primary = this.sc.tree.config.mode;
    const options: ReviewOption[] = nd.actions.map((a, i) => ({
      label: actionLabel(a, nd),
      freq: res.strategy[off + i * N + cls],
      evIcm: res.evIcm[off + i * N + cls],
      evChip: res.evChip[off + i * N + cls],
    }));
    const key = primary === 'icm' ? 'evIcm' : 'evChip';
    let best = 0;
    options.forEach((o, i) => { if ((o[key] ?? -Infinity) > (options[best][key] ?? -Infinity)) best = i; });
    const loss = Math.max(0, (options[best][key] ?? 0) - (options[option][key] ?? 0));
    const { lossBB, verdict } = this.grade(loss, primary, options[option].freq);
    const notes: string[] = [];
    const rare = this.rarePreflopNote();
    if (rare) notes.push(rare);
    const reach = this.preflopReach(this.heroSeat);
    const range = buildRangeReview(
      options.map((o) => o.label), cls, N, (u) => u, (u) => COMBOS[u], (u) => reach[u],
      (u, a) => res.strategy[off + a * N + u], (u, a) => res.evIcm[off + a * N + u], (u, a) => res.evChip[off + a * N + u],
      (c) => COMBOS[c],
    );
    const explanation = this.explainPreflopDecision(nd, options, option, best, primary, loss, lossBB, range);
    const review: ActionReview = { street: 'preflop', hand: this.handText(this.heroSeat), chosen: option, best, options, primary, loss, lossBB, verdict, approximate: false, notes, range, explanation };
    this.log(this.heroSeat, `${this.v.seatNames[this.heroSeat]} ${options[option].label}`, 'preflop', review);
    this.preTrail.push({ node: nd, action: option });
    this.preNode = nd.actions[option].child;
    this.v = { ...this.v, lastReview: review };
    if (nd.actions[option].type === 'fold') return this.finishHeroFold(options[option].evIcm);
    this.emit({ status: 'running', pending: null, lastReview: review });
    await this.runPreflop();
  }

  private explainPreflopDecision(
    nd: DecisionNode, options: ReviewOption[], chosen: number, best: number, primary: 'icm' | 'chip', loss: number, lossBB: number, range: RangeReview,
  ): Explanation {
    const tree = this.sc.tree;
    const res = this.sc.result;
    const h = this.heroSeat;
    const cls = this.classOf(h);
    const off = res.offsets[nd.dIndex];
    // last raiser before the hero
    let aggressor: number | null = null;
    for (const st of this.preTrail) {
      const t = st.node.actions[st.action].type;
      if (t === 'raise' || t === 'allin') aggressor = st.node.player;
    }
    // equity needed to call when the call leads to a heads-up all-in (others folding behind)
    let requiredChip: number | null = null;
    let requiredIcm: number | null = null;
    const callIdx = nd.actions.findIndex((a) => a.type === 'call');
    const foldIdx = nd.actions.findIndex((a) => a.type === 'fold');
    if (callIdx >= 0 && foldIdx >= 0) {
      let id = nd.actions[callIdx].child;
      for (let guard = 0; guard < 12; guard++) {
        const x = tree.nodes[id];
        if (x.kind === 'terminal') {
          if (x.tType === 'showdown' && x.participants.length === 2 && x.participants.includes(h)) {
            const oWin = x.outcomes.findIndex((o) => o[0] === h);
            const oLose = 1 - oWin;
            const n = this.n;
            const fI = res.evIcm[off + foldIdx * N + cls], fC = res.evChip[off + foldIdx * N + cls];
            const wI = x.utilIcm[oWin * n + h], lI = x.utilIcm[oLose * n + h];
            const wC = x.utilChip[oWin * n + h], lC = x.utilChip[oLose * n + h];
            if (Number.isFinite(fI) && wI !== lI) requiredIcm = Math.min(1, Math.max(0, (fI - lI) / (wI - lI)));
            if (Number.isFinite(fC) && wC !== lC) requiredChip = Math.min(1, Math.max(0, (fC - lC) / (wC - lC)));
          }
          break;
        }
        const fold = x.actions.findIndex((a) => a.type === 'fold');
        if (fold < 0) break;
        id = x.actions[fold].child;
      }
    }
    let playersLeft = 0;
    for (let s = h + 1; s < this.n; s++) if (!nd.folded[s]) playersLeft++;
    const openShare = range.summary.reduce((acc, x, i) => acc + (nd.actions[i].type === 'raise' || nd.actions[i].type === 'allin' ? x.freq : 0), 0);
    return explainPreflop({
      hand: this.handText(h),
      labels: options.map((o) => o.label),
      kinds: nd.actions.map((a) => a.type),
      freq: options.map((o) => o.freq),
      evIcm: options.map((o) => o.evIcm),
      evChip: options.map((o) => o.evChip),
      chosen, best, primary, loss, lossBB,
      heroClass: cls,
      heroName: this.v.seatNames[h],
      seatNames: this.v.seatNames,
      hero: h,
      pot: nd.pot,
      toCall: Math.max(0, Math.min(nd.bet - nd.contrib[h], nd.behind[h])),
      heroContrib: nd.contrib[h],
      heroBehind: nd.behind[h],
      isBlind: h >= this.n - 2,
      aggressor,
      aggressorAllin: aggressor !== null && nd.allin[aggressor],
      villainReach: aggressor !== null ? this.preflopReach(aggressor) : null,
      requiredChip,
      requiredIcm,
      playersLeft,
      heroOpenShare: aggressor === null ? openShare : null,
      startStacks: this.startStacks,
      payouts: this.payouts,
    });
  }

  private finalsAfterPreflop(t: TerminalNode): number[] {
    return this.startStacks.map((s, j) => s - this.ante[j] - t.contrib[j]);
  }

  private async preflopTerminal(t: TerminalNode) {
    this.syncPreflopTable(t);
    const parts = t.participants;
    if (t.tType === 'fold') {
      const finals = this.finalsAfterPreflop(t);
      finals[parts[0]] += t.pot;
      this.finish(finals, `${this.v.seatNames[parts[0]]} 팟 획득 (${t.pot.toFixed(1)}bb)`, []);
      return;
    }
    if (t.tType === 'showdown') {
      const board = this.draw(5);
      this.emit({ board, street: 'river' });
      this.showdownPreflop(t, board);
      return;
    }
    // players see a flop
    const ordered = parts.slice().sort((a, b) => postflopRank(a, this.n) - postflopRank(b, this.n));
    const base = this.finalsAfterPreflop(t);
    const reach = ordered.map((seat) => this.preflopReach(seat));
    if (ordered.length === 2) {
      this.pf = {
        seats: [ordered[0], ordered[1]],
        ranges: reach.map((r) => classToComboWeights(r)) as [Float64Array, Float64Array],
        pot: t.pot,
        base,
        board: [],
        street: 'flop',
        tree: null,
        result: null,
        node: 0,
        contrib: [0, 0],
      };
      await this.nextPostflopStreet();
    } else {
      this.mw = new MultiwayState(ordered, reach, t.pot, base);
      await this.nextMultiwayStreet();
    }
  }

  private preflopReach(seat: number): Float64Array {
    const r = new Float64Array(N).fill(1);
    const res = this.sc.result;
    for (const st of this.preTrail) {
      if (st.node.player !== seat) continue;
      const off = res.offsets[st.node.dIndex] + st.action * N;
      for (let h = 0; h < N; h++) r[h] *= res.strategy[off + h];
    }
    return r;
  }

  private draw(k: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < k; i++) out.push(this.deck.pop()!);
    return out;
  }

  private showdownPreflop(t: TerminalNode, board: number[]) {
    const strength = new Array(this.n).fill(-1);
    const shown: HandResult['shown'] = [];
    for (const s of t.participants) {
      const score = evaluate7([...this.holes[s], ...board]);
      strength[s] = score;
      shown.push({ seat: s, cards: this.holes[s], hand: handName(score) });
    }
    const win = payoutWithTies(t.contrib, t.folded, this.ante[this.n - 1], strength);
    const finals = this.finalsAfterPreflop(t).map((f, j) => f + win[j]);
    const winners = t.participants.filter((s) => win[s] > 0).map((s) => this.v.seatNames[s]);
    this.finish(finals, `올인 쇼다운 · ${winners.join(', ')} 승`, shown);
  }

  private finish(finals: number[], text: string, shown: HandResult['shown']) {
    const h = this.heroSeat;
    const eq0 = icmEquity(this.startStacks, this.payouts);
    const eq1 = icmEquity(finals, this.payouts, this.startStacks);
    const result: HandResult = { chip: finals[h] - this.startStacks[h], icm: (eq1[h] - eq0[h]) * 100, text, shown, summary: this.summary() };
    this.log(-1, text, this.v.street);
    this.emit({ status: 'done', pending: null, result, stacks: finals.map((f) => Math.max(0, f)), bets: new Array(this.n).fill(0) });
  }

  private summary(): HandSummary {
    return summarizeHand(
      this.v.log
        .map((e, logIndex) => ({ e, logIndex }))
        .filter(({ e }) => e.review)
        .map(({ e, logIndex }) => ({ logIndex, street: e.street, text: e.text, lossBB: e.review!.lossBB, verdict: e.review!.verdict, explanation: e.review!.explanation })),
    );
  }

  /** the hero is out: stop simulating the other players */
  private finishHeroFold(expectedIcm: number | null) {
    const h = this.heroSeat;
    const behind = this.mw ? this.mw.stack(h) : this.v.stacks[h];
    const chip = behind - this.startStacks[h];
    let icm = expectedIcm;
    if (icm === null) {
      // approximate: the pot goes to the remaining players evenly
      const finals = this.v.stacks.slice();
      if (this.mw) {
        const live = this.mw.live();
        for (const s of this.mw.seats) finals[s] = this.mw.stack(s);
        const pot = this.mw.pot + this.mw.streetTotal();
        for (const s of live) finals[s] += pot / live.length;
      }
      const eq0 = icmEquity(this.startStacks, this.payouts);
      const eq1 = icmEquity(finals, this.payouts, this.startStacks);
      icm = (eq1[h] - eq0[h]) * 100;
    }
    const text = '히어로 폴드 · 핸드 종료';
    this.log(-1, text, this.v.street);
    this.emit({ status: 'done', pending: null, result: { chip, icm, text, shown: [], summary: this.summary() } });
  }

  // ---------------------------------------------------------------- heads-up postflop (solver)

  private icmContext(pf: PostflopState) {
    return {
      mode: this.sc.tree.config.mode,
      payouts: this.payouts,
      startStacks: this.startStacks,
      baseStacks: pf.base.slice(),
      seats: pf.seats,
    } as PostflopSpot['icm'];
  }

  private async nextPostflopStreet(): Promise<void> {
    const pf = this.pf!;
    const cards = pf.street === 'flop' ? 3 : 1;
    pf.board = [...pf.board, ...this.draw(cards)];
    pf.contrib = [0, 0];
    this.v = { ...this.v, street: pf.street, board: pf.board.slice(), pot: pf.pot, bets: new Array(this.n).fill(0) };
    this.v.stacks = this.v.stacks.slice();
    for (const s of pf.seats) this.v.stacks[s] = pf.base[s];
    this.log(-1, `${streetName(pf.street)}: ${pf.board.map(cardText).join(' ')} (팟 ${pf.pot.toFixed(1)}bb)`, pf.street);

    if (pf.base[pf.seats[0]] <= 1e-9 || pf.base[pf.seats[1]] <= 1e-9) {
      // someone is all-in: run the board out
      if (pf.street === 'river') return this.postflopShowdown();
      pf.street = pf.street === 'flop' ? 'turn' : 'river';
      return this.nextPostflopStreet();
    }

    // keep the actual holdings in range so the solver produces strategies for them
    for (let p = 0; p < 2; p++) {
      const k = this.comboOf(pf.seats[p]);
      if (pf.ranges[p][k] < 1e-5) pf.ranges[p][k] = 1e-5;
    }
    const spot: PostflopSpot = { street: pf.street as PStreet, board: pf.board.slice(), pot: pf.pot, icm: this.icmContext(pf), sizing: DEFAULT_POSTFLOP_SIZING };
    pf.tree = buildPostflopTree(spot);
    this.emit({ status: 'solving', solvingStreet: pf.street, solveProgress: 0 });
    pf.result = await this.service.solve(spot, [pf.ranges[0].slice(), pf.ranges[1].slice()], (x) => this.emit({ solveProgress: x }));
    pf.node = 0;
    this.emit({ status: 'running', solveProgress: 1 });
    await this.runPostflop();
  }

  private async runPostflop(): Promise<void> {
    const pf = this.pf!;
    const tree = pf.tree!;
    for (;;) {
      const nd = tree.nodes[pf.node];
      if (nd.kind === 'chance' || (nd.kind === 'terminal' && nd.tType === 'equity')) return this.endPostflopStreet();
      if (nd.kind === 'terminal') {
        if (nd.tType === 'fold') return this.postflopFold(nd.winner);
        return this.endPostflopStreet();
      }
      const seat = pf.seats[nd.player];
      this.v = { ...this.v, bets: this.betsView(pf) };
      if (seat === this.heroSeat) {
        this.emit({
          status: 'hero',
          pending: { street: pf.street, options: nd.actions.map((a) => postflopActionLabel(a, nd)), toCall: Math.max(0, nd.contrib[1 - nd.player] - nd.contrib[nd.player]) },
        });
        return;
      }
      const idx = pf.result!.nodeIds.indexOf(nd.id);
      const combo = this.comboOf(seat);
      const freqs = nd.actions.map((_, a) => pf.result!.strategy[idx][a * NC + combo]);
      const a = this.sample(freqs);
      this.applyPostflopAction(nd, a);
    }
  }

  private betsView(pf: PostflopState): number[] {
    const bets = new Array(this.n).fill(0);
    bets[pf.seats[0]] = pf.contrib[0];
    bets[pf.seats[1]] = pf.contrib[1];
    return bets;
  }

  private applyPostflopAction(nd: PDecision, a: number, review?: ActionReview) {
    const pf = this.pf!;
    const seat = pf.seats[nd.player];
    const action = nd.actions[a];
    const label = postflopActionLabel(action, nd);
    // narrow the actor's range by the solver strategy for this action
    const idx = pf.result!.nodeIds.indexOf(nd.id);
    const strat = pf.result!.strategy[idx];
    const range = pf.ranges[nd.player];
    let before = 0, after = 0;
    for (let k = 0; k < NC; k++) {
      before += range[k];
      range[k] *= strat[a * NC + k];
      after += range[k];
    }
    if (review && before > 0 && after / before < 0.001)
      review.notes.push('이 액션은 솔버가 거의 쓰지 않아, 이후 스트리트의 레인지와 EV 신뢰도가 낮습니다.');
    if (after <= 0) for (let k = 0; k < NC; k++) range[k] = 1e-6;
    pf.contrib[nd.player] = action.to;
    const stacks = this.v.stacks.slice();
    stacks[seat] = pf.base[seat] - action.to;
    const allin = this.v.allin.slice();
    if (stacks[seat] <= 1e-9) allin[seat] = true;
    const folded = this.v.folded.slice();
    if (action.type === 'fold') folded[seat] = true;
    this.log(seat, `${this.v.seatNames[seat]} ${label}`, pf.street, review);
    this.v = { ...this.v, stacks, allin, folded, pot: pf.pot + pf.contrib[0] + pf.contrib[1], bets: this.betsView(pf) };
    pf.node = action.child;
  }

  private async actPostflop(option: number) {
    const pf = this.pf!;
    const nd = pf.tree!.nodes[pf.node] as PDecision;
    const idx = pf.result!.nodeIds.indexOf(nd.id);
    const combo = this.comboOf(this.heroSeat);
    const primary = this.sc.tree.config.mode;
    const options: ReviewOption[] = nd.actions.map((a, i) => ({
      label: postflopActionLabel(a, nd),
      freq: pf.result!.strategy[idx][i * NC + combo],
      evIcm: nanToNull(pf.result!.evIcm[idx][i * NC + combo]),
      evChip: nanToNull(pf.result!.evChip[idx][i * NC + combo]),
    }));
    const key = primary === 'icm' ? 'evIcm' : 'evChip';
    let best = 0;
    options.forEach((o, i) => { if ((o[key] ?? -Infinity) > (options[best][key] ?? -Infinity)) best = i; });
    const loss = Math.max(0, (options[best][key] ?? 0) - (options[option][key] ?? 0));
    const { lossBB, verdict } = this.grade(loss, primary, options[option].freq);
    const notes: string[] = [];
    if (pf.street === 'flop') notes.push('플랍 솔브는 턴·리버를 체크다운으로 가정한 근사입니다.');
    if (pf.result!.exploitability > 0.5) notes.push(`솔브 수렴도가 낮습니다 (착취 가능도 ${pf.result!.exploitability.toFixed(2)}).`);
    const heroRange = pf.ranges[nd.player];
    const dead = new Uint8Array(52);
    for (const c of pf.board) dead[c] = 1;
    const live = (k: number) => !dead[COMBO_C1[k]] && !dead[COMBO_C2[k]];
    const capacity = new Float64Array(N);
    for (let k = 0; k < NC; k++) if (live(k)) capacity[COMBO_CLASS[k]] += 1;
    const res = pf.result!;
    const range = buildRangeReview(
      options.map((o) => o.label), COMBO_CLASS[combo], NC, (k) => COMBO_CLASS[k], () => 1,
      (k) => (live(k) ? heroRange[k] : 0),
      (k, a) => res.strategy[idx][a * NC + k], (k, a) => res.evIcm[idx][a * NC + k], (k, a) => res.evChip[idx][a * NC + k],
      (c) => capacity[c],
    );
    // equity needed to call on the river, from the showdown utilities (other streets use pot odds)
    let requiredChip: number | null = null;
    let requiredIcm: number | null = null;
    const callIdx = nd.actions.findIndex((a) => a.type === 'call');
    const foldIdx = nd.actions.findIndex((a) => a.type === 'fold');
    const p = nd.player;
    if (callIdx >= 0 && foldIdx >= 0) {
      const t = pf.tree!.nodes[nd.actions[callIdx].child];
      if (t.kind === 'terminal' && t.tType === 'showdown' && options[foldIdx].evIcm !== null && options[foldIdx].evChip !== null) {
        const wI = t.utilIcm[p * 2 + p], lI = t.utilIcm[(1 - p) * 2 + p];
        const wC = t.utilChip[p * 2 + p], lC = t.utilChip[(1 - p) * 2 + p];
        if (wI !== lI) requiredIcm = Math.min(1, Math.max(0, (options[foldIdx].evIcm! - lI) / (wI - lI)));
        if (wC !== lC) requiredChip = Math.min(1, Math.max(0, (options[foldIdx].evChip! - lC) / (wC - lC)));
      }
    }
    const villainSeat = pf.seats[1 - p];
    const explanation = explainPostflop({
      hand: this.handText(this.heroSeat),
      labels: options.map((o) => o.label),
      kinds: nd.actions.map((a) => a.type),
      freq: options.map((o) => o.freq),
      evIcm: options.map((o) => o.evIcm),
      evChip: options.map((o) => o.evChip),
      chosen: option, best, primary, loss, lossBB,
      street: pf.street as 'flop' | 'turn' | 'river',
      hole: this.holes[this.heroSeat],
      board: pf.board.slice(),
      villainName: this.v.seatNames[villainSeat],
      pot: nd.pot,
      toCall: Math.max(0, nd.contrib[1 - p] - nd.contrib[p]),
      heroBehind: nd.behind[p],
      villainBehind: nd.behind[1 - p],
      inPosition: p === 1,
      heroRange: heroRange.slice(),
      villainRange: pf.ranges[1 - p].slice(),
      requiredChip,
      requiredIcm,
    });
    const review: ActionReview = { street: pf.street, hand: this.handText(this.heroSeat), chosen: option, best, options, primary, loss, lossBB, verdict, approximate: pf.street === 'flop', notes, range, explanation };
    this.applyPostflopAction(nd, option, review);
    this.emit({ status: 'running', pending: null, lastReview: review });
    await this.runPostflop();
  }

  private postflopFold(winner: number) {
    const pf = this.pf!;
    const finals = this.v.stacks.slice();
    for (let p = 0; p < 2; p++) finals[pf.seats[p]] = pf.base[pf.seats[p]] - pf.contrib[p];
    finals[pf.seats[winner]] += pf.pot + pf.contrib[0] + pf.contrib[1];
    this.finish(this.withOthers(finals), `${this.v.seatNames[pf.seats[winner]]} 팟 획득`, []);
  }

  /** stacks of players outside the hand never change after the preflop */
  private withOthers(finals: number[]): number[] {
    const pf = this.pf;
    const mw = this.mw;
    const base = pf ? pf.base : mw!.base;
    return finals.map((f, s) => ((pf && pf.seats.includes(s)) || (mw && mw.seats.includes(s)) ? f : base[s]));
  }

  private async endPostflopStreet(): Promise<void> {
    const pf = this.pf!;
    const matched = Math.min(pf.contrib[0], pf.contrib[1]);
    for (let p = 0; p < 2; p++) pf.base[pf.seats[p]] -= matched;
    pf.pot += 2 * matched;
    // uncalled excess goes back (only possible with an all-in for less)
    if (pf.street === 'river') return this.postflopShowdown();
    pf.street = pf.street === 'flop' ? 'turn' : 'river';
    await this.nextPostflopStreet();
  }

  private postflopShowdown() {
    const pf = this.pf!;
    while (pf.board.length < 5) pf.board.push(this.deck.pop()!);
    const [s0, s1] = pf.seats;
    const e0 = evaluate7([...this.holes[s0], ...pf.board]);
    const e1 = evaluate7([...this.holes[s1], ...pf.board]);
    const finals = this.v.stacks.slice();
    finals[s0] = pf.base[s0];
    finals[s1] = pf.base[s1];
    if (e0 > e1) finals[s0] += pf.pot;
    else if (e1 > e0) finals[s1] += pf.pot;
    else { finals[s0] += pf.pot / 2; finals[s1] += pf.pot / 2; }
    const text = e0 === e1 ? '쇼다운 · 스플릿' : `쇼다운 · ${this.v.seatNames[e0 > e1 ? s0 : s1]} 승`;
    this.v = { ...this.v, board: pf.board.slice() };
    this.finish(this.withOthers(finals), text, [
      { seat: s0, cards: this.holes[s0], hand: handName(e0) },
      { seat: s1, cards: this.holes[s1], hand: handName(e1) },
    ]);
  }

  // ---------------------------------------------------------------- multiway postflop (heuristic)

  private async nextMultiwayStreet(): Promise<void> {
    const mw = this.mw!;
    const cards = mw.street === 'flop' ? 3 : 1;
    mw.board = [...mw.board, ...this.draw(cards)];
    mw.startRound();
    this.v = { ...this.v, street: mw.street, board: mw.board.slice(), pot: mw.pot, bets: new Array(this.n).fill(0) };
    this.log(-1, `${streetName(mw.street)}: ${mw.board.map(cardText).join(' ')} (팟 ${mw.pot.toFixed(1)}bb, ${mw.live().length}인)`, mw.street);
    if (mw.live().filter((s) => mw.stack(s) > 1e-9).length <= 1) {
      if (mw.street === 'river') return this.multiwayShowdown();
      mw.street = mw.street === 'flop' ? 'turn' : 'river';
      return this.nextMultiwayStreet();
    }
    await this.runMultiway();
  }

  private async runMultiway(): Promise<void> {
    const mw = this.mw!;
    for (;;) {
      if (mw.live().length === 1) return this.multiwayFold();
      const seat = mw.nextToAct();
      if (seat < 0) {
        mw.closeRound();
        if (mw.street === 'river') return this.multiwayShowdown();
        mw.street = mw.street === 'flop' ? 'turn' : 'river';
        return this.nextMultiwayStreet();
      }
      this.syncMultiwayTable();
      const opts = mw.options(seat);
      if (seat === this.heroSeat) {
        this.emit({ status: 'hero', pending: { street: mw.street, options: opts.map((o) => o.label), toCall: mw.toCall(seat) } });
        return;
      }
      const eq = this.multiwayEquity(seat, 400);
      const choice = mw.botChoice(seat, opts, eq, this.rand);
      this.log(seat, `${this.v.seatNames[seat]} ${opts[choice].label}`, mw.street);
      mw.apply(seat, opts[choice]);
    }
  }

  private syncMultiwayTable() {
    const mw = this.mw!;
    const stacks = this.v.stacks.slice();
    const bets = new Array(this.n).fill(0);
    const folded = this.v.folded.slice();
    const allin = this.v.allin.slice();
    for (const s of mw.seats) {
      stacks[s] = mw.stack(s);
      bets[s] = mw.bet(s);
      folded[s] = mw.folded.has(s);
      allin[s] = mw.stack(s) <= 1e-9 && !folded[s];
    }
    this.v = { ...this.v, stacks, bets, folded, allin, pot: mw.pot + mw.streetTotal() };
  }

  /** Monte Carlo equity of a seat's actual hand against the other live players' preflop ranges */
  private multiwayEquity(seat: number, samples: number): number {
    const mw = this.mw!;
    const opps = mw.live().filter((s) => s !== seat);
    const known = [...this.holes[seat], ...mw.board];
    let score = 0;
    const be = new BoardEvaluator();
    for (let t = 0; t < samples; t++) {
      const used = new Set(known);
      const oppHands: Array<[number, number]> = [];
      for (const o of opps) {
        const r = mw.reach[mw.seats.indexOf(o)];
        let pick: [number, number] | null = null;
        for (let tries = 0; tries < 50 && !pick; tries++) {
          const cls = this.sample(Array.from(r, (w, h) => w * COMBOS[h]));
          const combos = classCombosCached(cls);
          const [a, b] = combos[Math.floor(this.rand() * combos.length)];
          if (!used.has(a) && !used.has(b)) pick = [a, b];
        }
        if (!pick) continue;
        used.add(pick[0]); used.add(pick[1]);
        oppHands.push(pick);
      }
      const rest: number[] = [];
      for (let c = 0; c < 52; c++) if (!used.has(c)) rest.push(c);
      const board = mw.board.slice();
      while (board.length < 5) board.push(rest.splice(Math.floor(this.rand() * rest.length), 1)[0]);
      be.setBoard(board);
      const mine = be.eval2(this.holes[seat][0], this.holes[seat][1]);
      let best = true, ties = 1;
      for (const [a, b] of oppHands) {
        const s = be.eval2(a, b);
        if (s > mine) { best = false; break; }
        if (s === mine) ties++;
      }
      if (best) score += 1 / ties;
    }
    return score / samples;
  }

  private async actMultiway(option: number) {
    const mw = this.mw!;
    const seat = this.heroSeat;
    const opts = mw.options(seat);
    const eq = this.multiwayEquity(seat, 1500);
    const toCall = mw.toCall(seat);
    const potNow = mw.pot + mw.streetTotal();
    // chip EV relative to folding now, assuming the hand checks down after this action
    const options: ReviewOption[] = opts.map((o) => {
      let ev: number | null = null;
      if (o.kind === 'fold') ev = 0;
      else if (o.kind === 'check') ev = eq * potNow;
      else if (o.kind === 'call') ev = eq * (potNow + toCall) - toCall;
      return { label: o.label, freq: null, evIcm: null, evChip: ev };
    });
    let best = 0;
    options.forEach((o, i) => { if ((o.evChip ?? -Infinity) > (options[best].evChip ?? -Infinity)) best = i; });
    const chosen = options[option];
    const loss = chosen.evChip === null ? 0 : Math.max(0, (options[best].evChip ?? 0) - chosen.evChip);
    const required = toCall > 0 ? toCall / (potNow + toCall) : 0;
    const notes = [
      `${mw.live().length}인 팟은 솔버를 지원하지 않아 에퀴티 기반 근사 리뷰입니다.`,
      `상대 레인지 대비 에퀴티 ${(eq * 100).toFixed(1)}%${toCall > 0 ? ` · 콜에 필요한 에퀴티 ${(required * 100).toFixed(1)}%` : ''}.`,
    ];
    if (chosen.evChip === null) notes.push('베팅·레이즈의 EV는 상대 대응을 모델링하지 않아 계산하지 않았습니다.');
    const verdict: Verdict = chosen.evChip === null ? 'info' : loss <= 0.05 ? 'best' : loss <= 0.3 ? 'inaccuracy' : loss <= 1.5 ? 'mistake' : 'blunder';
    const explanation = explainMultiway({
      hand: this.handText(seat),
      labels: options.map((o) => o.label),
      kinds: opts.map((o) => o.kind),
      freq: options.map(() => null),
      evIcm: options.map(() => null),
      evChip: options.map((o) => o.evChip),
      chosen: option, best, primary: 'chip', loss, lossBB: loss,
      street: mw.street as 'flop' | 'turn' | 'river',
      hole: this.holes[seat],
      board: mw.board.slice(),
      equity: eq,
      toCall,
      pot: potNow,
      players: mw.live().length,
    });
    const review: ActionReview = { street: mw.street, hand: this.handText(seat), chosen: option, best, options, primary: 'chip', loss, lossBB: loss, verdict, approximate: true, notes, explanation };
    this.log(seat, `${this.v.seatNames[seat]} ${opts[option].label}`, mw.street, review);
    mw.apply(seat, opts[option]);
    this.v = { ...this.v, lastReview: review };
    if (opts[option].kind === 'fold') return this.finishHeroFold(null);
    this.emit({ status: 'running', pending: null, lastReview: review });
    await this.runMultiway();
  }

  private multiwayFold() {
    const mw = this.mw!;
    mw.closeRound();
    const winner = mw.live()[0];
    const finals = this.v.stacks.slice();
    for (const s of mw.seats) finals[s] = mw.stack(s);
    finals[winner] += mw.pot;
    this.finish(this.withOthers(finals), `${this.v.seatNames[winner]} 팟 획득`, []);
  }

  private multiwayShowdown() {
    const mw = this.mw!;
    mw.closeRound();
    while (mw.board.length < 5) mw.board.push(this.deck.pop()!);
    const strength = new Array(this.n).fill(-1);
    const shown: HandResult['shown'] = [];
    for (const s of mw.live()) {
      const score = evaluate7([...this.holes[s], ...mw.board]);
      strength[s] = score;
      shown.push({ seat: s, cards: this.holes[s], hand: handName(score) });
    }
    const contrib = new Array(this.n).fill(0);
    const folded = new Array(this.n).fill(true);
    for (const s of mw.seats) { contrib[s] = mw.invested(s); folded[s] = mw.folded.has(s); }
    const win = payoutWithTies(contrib, folded, mw.deadMoney(), strength);
    const finals = this.v.stacks.slice();
    for (const s of mw.seats) finals[s] = mw.stack(s) + win[s];
    const winners = mw.live().filter((s) => win[s] > 0).map((s) => this.v.seatNames[s]);
    this.v = { ...this.v, board: mw.board.slice() };
    this.finish(this.withOthers(finals), `쇼다운 · ${winners.join(', ')} 승`, shown);
  }
}

interface PostflopState {
  seats: [number, number];
  ranges: [Float64Array, Float64Array];
  /** pot when the current street started */
  pot: number;
  /** every seat's chips behind when the current street started */
  base: number[];
  board: number[];
  street: Street;
  tree: PostflopTree | null;
  result: PostflopResult | null;
  node: number;
  contrib: [number, number];
}

function classToComboWeights(reach: Float64Array): Float64Array {
  const out = new Float64Array(NC);
  for (let k = 0; k < NC; k++) out[k] = reach[COMBO_CLASS[k]];
  return out;
}

function nanToNull(x: number): number | null {
  return Number.isFinite(x) ? x : null;
}

function streetName(s: Street): string {
  return s === 'preflop' ? '프리플랍' : s === 'flop' ? '플랍' : s === 'turn' ? '턴' : '리버';
}

const COMBO_CACHE = new Map<number, Array<[number, number]>>();
function classCombosCached(cls: number): Array<[number, number]> {
  let v = COMBO_CACHE.get(cls);
  if (!v) {
    v = [];
    for (let k = 0; k < NC; k++) if (COMBO_CLASS[k] === cls) v.push([COMBO_C1[k], COMBO_C2[k]]);
    COMBO_CACHE.set(cls, v);
  }
  return v;
}

type MwOption = { kind: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin'; to: number; label: string };

/** Simplified betting for 3-4 player pots: one bet size, one raise size, all-in. */
class MultiwayState {
  seats: number[];
  reach: Float64Array[];
  pot: number;
  base: number[];
  board: number[] = [];
  street: Street = 'flop';
  folded = new Set<number>();
  private behind = new Map<number, number>();
  private contrib = new Map<number, number>();
  private totalIn = new Map<number, number>();
  private acted = new Set<number>();
  private raises = 0;
  private dead: number;

  constructor(seats: number[], reach: Float64Array[], pot: number, base: number[]) {
    this.seats = seats;
    this.reach = reach;
    this.pot = pot;
    this.base = base;
    this.dead = pot;
    for (const s of seats) { this.behind.set(s, base[s]); this.totalIn.set(s, 0); }
  }

  live() { return this.seats.filter((s) => !this.folded.has(s)); }
  stack(s: number) { return this.behind.get(s)!; }
  bet(s: number) { return this.contrib.get(s) ?? 0; }
  invested(s: number) { return this.totalIn.get(s)!; }
  deadMoney() { return this.dead; }
  streetTotal() { let t = 0; for (const v of this.contrib.values()) t += v; return t; }
  private maxBet() { let m = 0; for (const v of this.contrib.values()) m = Math.max(m, v); return m; }
  toCall(s: number) { return Math.min(this.maxBet() - this.bet(s), this.stack(s)); }

  startRound() {
    this.contrib = new Map(this.seats.map((s) => [s, 0]));
    this.acted.clear();
    this.raises = 0;
  }

  nextToAct(): number {
    const max = this.maxBet();
    for (const s of this.seats) {
      if (this.folded.has(s) || this.stack(s) <= 1e-9) continue;
      if (!this.acted.has(s) || this.bet(s) < max - 1e-9) {
        // nobody else can respond to a bet: stop
        const others = this.live().filter((o) => o !== s && this.stack(o) > 1e-9);
        if (others.length === 0 && this.bet(s) >= max - 1e-9) continue;
        return s;
      }
    }
    return -1;
  }

  options(s: number): MwOption[] {
    const pot = this.pot + this.streetTotal();
    const call = this.toCall(s);
    const total = this.bet(s) + this.stack(s);
    const out: MwOption[] = [];
    const fmt = (x: number) => (Math.round(x * 10) / 10).toString();
    if (call <= 1e-9) {
      out.push({ kind: 'check', to: this.bet(s), label: 'Check' });
      const to = Math.round(0.66 * pot * 100) / 100;
      if (to < total * 0.67) out.push({ kind: 'bet', to, label: `Bet ${fmt(to)} (66%)` });
      out.push({ kind: 'allin', to: total, label: `All-in ${fmt(total)}` });
    } else {
      out.push({ kind: 'fold', to: this.bet(s), label: 'Fold' });
      out.push({ kind: 'call', to: this.bet(s) + call, label: `Call ${fmt(call)}` });
      if (total > this.maxBet() + 1e-9 && this.raises < 2) {
        const to = Math.round((this.maxBet() + (pot + call)) * 100) / 100;
        if (to < total * 0.67) out.push({ kind: 'raise', to, label: `Raise ${fmt(to)}` });
        out.push({ kind: 'allin', to: total, label: `All-in ${fmt(total)}` });
      }
    }
    return out;
  }

  apply(s: number, o: MwOption) {
    this.acted.add(s);
    if (o.kind === 'fold') { this.folded.add(s); return; }
    const add = o.to - this.bet(s);
    this.contrib.set(s, o.to);
    this.behind.set(s, Math.max(0, this.stack(s) - add));
    this.totalIn.set(s, this.invested(s) + add);
    if (o.kind === 'bet' || o.kind === 'raise' || (o.kind === 'allin' && o.to > this.maxBetExcept(s))) {
      this.raises++;
      this.acted = new Set([s]);
    }
  }

  private maxBetExcept(s: number) { let m = 0; for (const [k, v] of this.contrib) if (k !== s) m = Math.max(m, v); return m; }

  closeRound() {
    this.pot += this.streetTotal();
    this.contrib = new Map(this.seats.map((s) => [s, 0]));
  }

  botChoice(s: number, opts: MwOption[], eq: number, rand: Rand): number {
    const k = this.live().length;
    const call = this.toCall(s);
    const pot = this.pot + this.streetTotal();
    const find = (kind: MwOption['kind']) => opts.findIndex((o) => o.kind === kind);
    const strong = 1.6 / k;
    if (call <= 1e-9) {
      if (eq > strong && find('bet') >= 0 && rand() < 0.75) return find('bet');
      if (eq > 0.85 && rand() < 0.5) return find('allin');
      return find('check');
    }
    const required = call / (pot + call);
    if (eq > Math.max(0.75, strong + 0.2) && find('raise') >= 0 && rand() < 0.5) return find('raise');
    if (eq >= required + 0.03) return find('call');
    return find('fold');
  }
}
