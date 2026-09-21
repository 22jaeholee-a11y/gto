// 솔버 탭의 헤즈업 포스트플랍 탐색기.
// 보드를 직접 받고, 양쪽 액션을 사용자가 고르며, 스트리트마다 좁혀진 레인지로 다시 솔브한다.
// 트레이닝 모드와 달리 딜링도 봇도 없다.

import { COMBO_C1, COMBO_C2, NC } from './combos';
import type { PostflopResult } from './solver';
import type { PostflopService, PreflopExit } from './spot';
import {
  buildPostflopTree, DEFAULT_POSTFLOP_SIZING,
  type PDecision, type PostflopSpot, type PostflopTree, type Street,
} from './tree';

const CARDS_NEEDED: Record<Street, number> = { flop: 3, turn: 1, river: 1 };
const CACHE_LIMIT = 8;

/** runout: 리버 전에 양쪽이 올인이라 남은 보드가 그냥 깔리는 경우 */
export type Ending = { kind: 'fold'; winner: 0 | 1 } | { kind: 'showdown'; runout: boolean } | null;

export interface ExploreState {
  /** need-cards: 다음 스트리트 카드를 기다림 / solving / ready / done */
  status: 'need-cards' | 'solving' | 'ready' | 'done';
  street: Street;
  board: number[];
  /** 지금 필요한 카드 장수 (status가 need-cards일 때만 의미 있음) */
  needed: number;
  /** 현재 스트리트가 시작될 때의 팟 */
  pot: number;
  node: number;
  tree: PostflopTree | null;
  result: PostflopResult | null;
  ranges: [Float64Array, Float64Array];
  contrib: [number, number];
  progress: number;
  ending: Ending;
  error: string | null;
}

interface Snapshot {
  status: ExploreState['status'];
  street: Street;
  board: number[];
  pot: number;
  node: number;
  tree: PostflopTree | null;
  result: PostflopResult | null;
  ranges: [Float64Array, Float64Array];
  contrib: [number, number];
  base: number[];
  baseStacks: number[];
  /** 지금까지 고른 액션들 (솔브 캐시 키의 일부) */
  actionKey: string;
  ending: Ending;
}

export class PostflopExplorer {
  readonly heroPlayer: 0 | 1;
  private exit: PreflopExit;
  private service: PostflopService;
  private listeners = new Set<() => void>();
  private cache = new Map<string, PostflopResult>();
  private history: Snapshot[] = [];
  private heroCombo: number | null = null;
  private v: ExploreState;
  /** 현재 스트리트 시작 시점의 좌석별 남은 칩 */
  private base: number[];
  private baseStacks: number[];
  /** 지금까지 고른 액션들. 보드와 합쳐 솔브 캐시 키를 만든다 (제자리 누적 금지) */
  private actionKey = '';

  constructor(exit: PreflopExit, heroSeat: number, service: PostflopService) {
    this.exit = exit;
    this.service = service;
    this.heroPlayer = exit.seats[0] === heroSeat ? 0 : 1;
    this.base = exit.base.slice();
    this.baseStacks = exit.icm.baseStacks.slice();
    this.v = {
      status: 'need-cards',
      street: 'flop',
      board: [],
      needed: 3,
      pot: exit.pot,
      node: 0,
      tree: null,
      result: null,
      ranges: [exit.ranges[0].slice(), exit.ranges[1].slice()],
      contrib: [0, 0],
      progress: 0,
      ending: null,
      error: null,
    };
  }

  get state(): ExploreState {
    return this.v;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  canUndo(): boolean {
    return this.history.length > 0;
  }

  /** 포스트플랍 플레이어 번호(0 = OOP)를 테이블 좌석 번호로 바꾼다. */
  seatOf(p: 0 | 1): number {
    return this.exit.seats[p];
  }

  /** 보드와 히어로 카드 — 카드 선택기에서 고를 수 없는 카드들. */
  deadCards(): number[] {
    const out = this.v.board.slice();
    if (this.heroCombo !== null) out.push(COMBO_C1[this.heroCombo], COMBO_C2[this.heroCombo]);
    return out;
  }

  private emit(patch: Partial<ExploreState>): void {
    this.v = { ...this.v, ...patch };
    for (const fn of this.listeners) fn();
  }

  private snapshot(): Snapshot {
    return {
      status: this.v.status,
      street: this.v.street,
      board: this.v.board.slice(),
      pot: this.v.pot,
      node: this.v.node,
      tree: this.v.tree,
      result: this.v.result,
      ranges: [this.v.ranges[0].slice(), this.v.ranges[1].slice()],
      contrib: [this.v.contrib[0], this.v.contrib[1]],
      base: this.base.slice(),
      baseStacks: this.baseStacks.slice(),
      actionKey: this.actionKey,
      ending: this.v.ending,
    };
  }

  private restore(s: Snapshot): void {
    this.base = s.base;
    this.baseStacks = s.baseStacks;
    this.actionKey = s.actionKey;
    this.emit({
      status: s.status, street: s.street, board: s.board, needed: CARDS_NEEDED[s.street],
      pot: s.pot, node: s.node, tree: s.tree, result: s.result, ranges: s.ranges,
      contrib: s.contrib, ending: s.ending, progress: s.status === 'ready' ? 1 : 0, error: null,
    });
  }

  /** 히어로 콤보를 바꾼다. 이미 솔브했으면 현재 스트리트를 다시 푼다. */
  async setHeroCombo(combo: number): Promise<void> {
    if (this.heroCombo === combo) return;
    this.heroCombo = combo;
    this.cache.clear();
    // 콤보는 플로어 주입에만 영향을 주므로 스트리트 도중에는 다시 풀지 않는다.
    // (액션이 이미 진행됐거나 라인이 끝났으면 다음 솔브에서 반영된다)
    if (this.v.status === 'ready' && this.v.node === 0) await this.solveStreet();
  }

  /** 현재 스트리트에 필요한 카드를 넘긴다 (플랍 3장, 턴·리버 1장). */
  async setCards(cards: number[]): Promise<void> {
    if (this.v.status !== 'need-cards') return;
    const need = CARDS_NEEDED[this.v.street];
    if (cards.length !== need) {
      this.emit({ error: `${need}장을 골라주세요` });
      return;
    }
    const dead = new Set(this.deadCards());
    for (const c of cards) {
      if (dead.has(c)) { this.emit({ error: '이미 쓰인 카드입니다' }); return; }
      dead.add(c);
    }
    this.history.push(this.snapshot());
    this.emit({ board: [...this.v.board, ...cards], error: null });
    await this.solveStreet();
  }

  private async solveStreet(): Promise<void> {
    // 히어로 콤보를 레인지에 남겨 솔버가 그 콤보의 전략을 내게 한다
    const ranges: [Float64Array, Float64Array] = [this.v.ranges[0].slice(), this.v.ranges[1].slice()];
    if (this.heroCombo !== null && ranges[this.heroPlayer][this.heroCombo] < 1e-5) {
      ranges[this.heroPlayer][this.heroCombo] = 1e-5;
    }
    const spot: PostflopSpot = {
      street: this.v.street,
      board: this.v.board.slice(),
      pot: this.v.pot,
      icm: { ...this.exit.icm, baseStacks: this.baseStacks.slice() },
      sizing: DEFAULT_POSTFLOP_SIZING,
    };
    const tree = buildPostflopTree(spot);
    const key = `${this.v.board.join(',')}|${this.actionKey}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);       // 다시 넣어 최근 사용으로 올린다 (LRU)
      this.cache.set(key, cached);
      this.emit({ tree, result: cached, node: 0, contrib: [0, 0], status: 'ready', progress: 1 });
      return this.advance();
    }
    this.emit({ tree, status: 'solving', progress: 0, node: 0, contrib: [0, 0] });
    try {
      const result = await this.service.solve(spot, ranges, (x) => this.emit({ progress: x }));
      this.cache.set(key, result);
      if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value as string);
      this.emit({ result, status: 'ready', progress: 1 });
      await this.advance();
    } catch (e) {
      // 이 되돌리기는 setCards가 이번 스트리트 카드를 방금 붙인 경우만 겨냥한다
      // (setHeroCombo는 이제 스트리트 시작 지점에서만 다시 풀어 여기로 들어오지 않는다)
      this.emit({ status: 'need-cards', error: e instanceof Error ? e.message : '포스트플랍 솔브 실패', board: this.v.board.slice(0, this.v.board.length - CARDS_NEEDED[this.v.street]) });
    }
  }

  /** 현재 노드가 결정이 아니면 스트리트를 닫거나 라인을 끝낸다. */
  private async advance(): Promise<void> {
    const tree = this.v.tree;
    if (!tree) return;
    const nd = tree.nodes[this.v.node];
    if (nd.kind === 'decision') return;
    if (nd.kind === 'terminal' && nd.tType === 'fold') {
      this.emit({ status: 'done', ending: { kind: 'fold', winner: nd.winner as 0 | 1 } });
      return;
    }
    // chance / showdown / equity: 이번 스트리트의 베팅이 끝났다
    await this.closeStreet();
  }

  private async closeStreet(): Promise<void> {
    const matched = Math.min(this.v.contrib[0], this.v.contrib[1]);
    const base = this.base.slice();
    for (let p = 0; p < 2; p++) base[this.exit.seats[p]] -= matched;
    this.base = base;
    this.baseStacks = base.slice();
    const pot = this.v.pot + 2 * matched;
    // 양쪽이 올인이면 남은 보드는 런아웃이라 더 솔브할 것이 없다
    const chipsLeft = base[this.exit.seats[0]] > 1e-9 && base[this.exit.seats[1]] > 1e-9;
    if (this.v.street === 'river' || !chipsLeft) {
      this.emit({ status: 'done', ending: { kind: 'showdown', runout: this.v.street !== 'river' }, pot });
      return;
    }
    const next: Street = this.v.street === 'flop' ? 'turn' : 'river';
    this.emit({ status: 'need-cards', street: next, needed: CARDS_NEEDED[next], pot, contrib: [0, 0], node: 0, tree: null, result: null });
  }

  /** 현재 결정 노드에서 액션 하나를 고른다. 그 플레이어의 레인지를 전략만큼 좁힌다. */
  async act(action: number): Promise<void> {
    if (this.v.status !== 'ready') return;
    const tree = this.v.tree;
    const result = this.v.result;
    if (!tree || !result) return;
    const nd = tree.nodes[this.v.node];
    if (nd.kind !== 'decision') return;
    const a = nd.actions[action];
    if (!a) return;

    this.history.push(this.snapshot());

    const idx = result.nodeIds.indexOf(nd.id);
    const strat = result.strategy[idx];
    const ranges: [Float64Array, Float64Array] = [this.v.ranges[0].slice(), this.v.ranges[1].slice()];
    const range = ranges[nd.player];
    let after = 0;
    for (let k = 0; k < NC; k++) {
      range[k] *= strat[action * NC + k];
      after += range[k];
    }
    // 솔버가 거의 쓰지 않는 액션이라 레인지가 비면 균등 레인지로 되살린다 (이후 EV는 참고용)
    if (after <= 0) for (let k = 0; k < NC; k++) range[k] = 1e-6;

    const contrib: [number, number] = [this.v.contrib[0], this.v.contrib[1]];
    contrib[nd.player] = a.to;
    this.actionKey = `${this.actionKey}|${nd.id}:${action}`;
    this.emit({ ranges, contrib, node: a.child });
    await this.advance();
  }

  async undo(): Promise<void> {
    const s = this.history.pop();
    if (!s) return;
    this.restore(s);
  }
}
