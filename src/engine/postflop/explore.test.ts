import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type SolverConfig } from '../config';
import { NUM_CLASSES } from '../cards';
import { COMBO_INDEX, NC, parseCard } from './combos';
import { PostflopExplorer } from './explore';
import { preflopExit, type PostflopService, type PreflopExit } from './spot';
import type { PostflopResult } from './solver';
import { buildPostflopTree, DEFAULT_POSTFLOP_SIZING, type PDecision, type PostflopSpot } from './tree';

/** 모든 결정 노드에서 액션을 고르게 섞는 가짜 솔버. 호출 횟수를 센다. */
class FakeService implements PostflopService {
  calls = 0;
  lastRanges: [Float64Array, Float64Array] | null = null;

  solve(spot: PostflopSpot, ranges: [Float64Array, Float64Array]): Promise<PostflopResult> {
    this.calls++;
    this.lastRanges = [ranges[0].slice(), ranges[1].slice()];
    const tree = buildPostflopTree(spot);
    const nodeIds: number[] = [];
    for (const nd of tree.nodes) if (nd.kind === 'decision' && nd.root) nodeIds.push(nd.id);
    const strategy: Float32Array[] = [];
    const evIcm: Float32Array[] = [];
    const evChip: Float32Array[] = [];
    for (const id of nodeIds) {
      const nd = tree.nodes[id] as PDecision;
      const A = nd.actions.length;
      const s = new Float32Array(A * NC).fill(1 / A);
      const e = new Float32Array(A * NC);
      for (let a = 0; a < A; a++) for (let k = 0; k < NC; k++) e[a * NC + k] = a;
      strategy.push(s);
      evIcm.push(e);
      evChip.push(e.slice());
    }
    return Promise.resolve({ nodeIds, strategy, evIcm, evChip, exploitability: 0, iterations: 100 });
  }
}

const cfg: SolverConfig = { ...DEFAULT_CONFIG, stacks: [25, 25, 25, 25, 25, 25, 25, 25], mode: 'chip' };

function exitOf(): PreflopExit {
  const reachBySeat = Array.from({ length: 8 }, () => {
    const a = new Float64Array(NUM_CLASSES);
    a.fill(0.5);
    return a;
  });
  return preflopExit({ config: cfg, participants: [4, 7], pot: 5, contrib: [0, 0, 0, 0, 2, 0, 0.5, 2], reachBySeat });
}

const flop = ['2c', '7d', 'Ts'].map(parseCard);
const heroCombo = COMBO_INDEX[parseCard('As') * 52 + parseCard('Kh')];

describe('PostflopExplorer', () => {
  it('시작할 때 플랍 3장을 요구한다', () => {
    const ex = new PostflopExplorer(exitOf(), 7, new FakeService());
    expect(ex.state.status).toBe('need-cards');
    expect(ex.state.street).toBe('flop');
    expect(ex.state.needed).toBe(3);
    expect(ex.heroPlayer).toBe(0); // BB가 OOP
  });

  it('플랍을 받으면 솔브하고 준비 상태가 된다', async () => {
    const svc = new FakeService();
    const ex = new PostflopExplorer(exitOf(), 7, svc);
    await ex.setCards(flop);
    expect(svc.calls).toBe(1);
    expect(ex.state.status).toBe('ready');
    expect(ex.state.board).toEqual(flop);
    expect(ex.state.result).not.toBeNull();
  });

  it('히어로 콤보를 레인지에 남겨 솔버가 전략을 내게 한다', async () => {
    const svc = new FakeService();
    const ex = new PostflopExplorer(exitOf(), 7, svc);
    await ex.setHeroCombo(heroCombo);
    await ex.setCards(flop);
    expect(svc.lastRanges![0][heroCombo]).toBeGreaterThan(0);
  });

  it('액션을 진행하면 그 플레이어의 레인지가 전략만큼 좁혀진다', async () => {
    const ex = new PostflopExplorer(exitOf(), 7, new FakeService());
    await ex.setCards(flop);
    const before = ex.state.ranges[0].slice();
    const node = ex.state.tree!.nodes[ex.state.node] as PDecision;
    const A = node.actions.length;
    await ex.act(0);
    const after = ex.state.ranges[0];
    let live = 0;
    for (let k = 0; k < NC; k++) if (before[k] > 0) { expect(after[k]).toBeCloseTo(before[k] / A, 9); live++; }
    expect(live).toBeGreaterThan(0);
  });

  it('체크-체크로 스트리트가 끝나면 다음 카드를 요구한다', async () => {
    const ex = new PostflopExplorer(exitOf(), 7, new FakeService());
    await ex.setCards(flop);
    const check = (nd: PDecision) => nd.actions.findIndex((a) => a.type === 'check');
    await ex.act(check(ex.state.tree!.nodes[ex.state.node] as PDecision));
    await ex.act(check(ex.state.tree!.nodes[ex.state.node] as PDecision));
    expect(ex.state.status).toBe('need-cards');
    expect(ex.state.street).toBe('turn');
    expect(ex.state.needed).toBe(1);
  });

  it('턴 카드를 받으면 좁혀진 레인지로 다시 솔브한다', async () => {
    const svc = new FakeService();
    const ex = new PostflopExplorer(exitOf(), 7, svc);
    await ex.setCards(flop);
    const check = (nd: PDecision) => nd.actions.findIndex((a) => a.type === 'check');
    await ex.act(check(ex.state.tree!.nodes[ex.state.node] as PDecision));
    await ex.act(check(ex.state.tree!.nodes[ex.state.node] as PDecision));
    await ex.setCards([parseCard('3h')]);
    expect(svc.calls).toBe(2);
    expect(ex.state.status).toBe('ready');
    expect(ex.state.board.length).toBe(4);
  });

  it('폴드로 라인이 끝나면 승자를 알린다', async () => {
    const ex = new PostflopExplorer(exitOf(), 7, new FakeService());
    await ex.setCards(flop);
    const oop = ex.state.tree!.nodes[ex.state.node] as PDecision;
    const bet = oop.actions.findIndex((a) => a.type === 'bet');
    await ex.act(bet);
    const ip = ex.state.tree!.nodes[ex.state.node] as PDecision;
    await ex.act(ip.actions.findIndex((a) => a.type === 'fold'));
    expect(ex.state.status).toBe('done');
    expect(ex.state.ending).toEqual({ kind: 'fold', winner: 0 });
  });

  it('양쪽이 올인이면 카드를 더 받지 않고 런아웃으로 끝낸다', async () => {
    const ex = new PostflopExplorer(exitOf(), 7, new FakeService());
    await ex.setCards(flop);
    const oop = ex.state.tree!.nodes[ex.state.node] as PDecision;
    await ex.act(oop.actions.findIndex((a) => a.type === 'allin'));
    const ip = ex.state.tree!.nodes[ex.state.node] as PDecision;
    await ex.act(ip.actions.findIndex((a) => a.type === 'call'));
    expect(ex.state.status).toBe('done');
    expect(ex.state.ending).toEqual({ kind: 'showdown', runout: true });
  });

  it('되돌린 뒤 같은 액션을 다시 고르면 솔브를 반복하지 않는다', async () => {
    const svc = new FakeService();
    const ex = new PostflopExplorer(exitOf(), 7, svc);
    await ex.setCards(flop);
    const check = (nd: PDecision) => nd.actions.findIndex((a) => a.type === 'check');
    await ex.act(check(ex.state.tree!.nodes[ex.state.node] as PDecision));
    await ex.act(check(ex.state.tree!.nodes[ex.state.node] as PDecision));
    await ex.setCards([parseCard('3h')]);
    expect(svc.calls).toBe(2);
    await ex.undo(); // 턴 솔브 이전으로
    await ex.setCards([parseCard('3h')]);
    expect(svc.calls).toBe(2); // 캐시 적중
  });

  it('보드와 히어로 카드가 겹치지 않도록 dead 카드를 알려준다', async () => {
    const ex = new PostflopExplorer(exitOf(), 7, new FakeService());
    await ex.setHeroCombo(heroCombo);
    await ex.setCards(flop);
    const dead = ex.deadCards();
    for (const c of flop) expect(dead).toContain(c);
    expect(dead).toContain(parseCard('As'));
    expect(dead).toContain(parseCard('Kh'));
  });

  it('상태가 바뀔 때 구독자를 부른다', async () => {
    const ex = new PostflopExplorer(exitOf(), 7, new FakeService());
    let n = 0;
    const off = ex.subscribe(() => { n++; });
    await ex.setCards(flop);
    expect(n).toBeGreaterThan(0);
    off();
    const before = n;
    await ex.act(0);
    expect(n).toBe(before);
  });
});

// 사이즈 세트가 기본값인지 확인해 테스트가 트리 모양 가정에 기대는 것을 드러낸다
it('기본 사이즈 세트를 쓴다', () => {
  expect(DEFAULT_POSTFLOP_SIZING.flop.bets.length).toBeGreaterThan(0);
});
