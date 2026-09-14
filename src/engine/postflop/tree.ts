// Heads-up postflop betting tree for one street (plus river subtrees when solving the turn).

import { icmEquity } from '../icm';

export type Street = 'flop' | 'turn' | 'river';

export interface SizeSet {
  /** bet sizes as fractions of the pot */
  bets: number[];
  /** raise sizes as fractions of the pot after calling */
  raises: number[];
  allin: boolean;
}

export interface PostflopSizing {
  flop: SizeSet;
  turn: SizeSet;
  river: SizeSet;
  /** smaller river menu used inside turn solves to keep them tractable */
  riverInTurn: SizeSet;
  /** bets/raises allowed per street */
  maxRaises: number;
  /** a sized bet is dropped (all-in only) when it would commit this fraction of the stack */
  allinThreshold: number;
}

export const DEFAULT_POSTFLOP_SIZING: PostflopSizing = {
  flop: { bets: [0.33, 0.75], raises: [0.75], allin: true },
  turn: { bets: [0.66], raises: [], allin: true },
  river: { bets: [0.5, 1], raises: [0.75], allin: true },
  riverInTurn: { bets: [0.75], raises: [], allin: true },
  maxRaises: 3,
  allinThreshold: 0.67,
};

export interface IcmContext {
  mode: 'icm' | 'chip';
  /** payouts normalized to sum 1 */
  payouts: number[];
  /** every seat's stack at the start of the hand */
  startStacks: number[];
  /** every seat's chips behind when this street starts */
  baseStacks: number[];
  /** table seats of [OOP, IP] */
  seats: [number, number];
}

export interface PostflopSpot {
  street: Street;
  board: number[];
  /** chips in the middle when the street starts (all contributions and antes) */
  pot: number;
  icm: IcmContext;
  sizing: PostflopSizing;
}

export type PActType = 'check' | 'bet' | 'call' | 'fold' | 'raise' | 'allin';

export interface PAction {
  type: PActType;
  /** street contribution of the actor after the action */
  to: number;
  child: number;
}

export interface PDecision {
  kind: 'decision';
  id: number;
  player: 0 | 1;
  street: Street;
  /** true for nodes of the street being solved (not inside river subtrees) */
  root: boolean;
  boardId: number;
  pot: number;
  contrib: [number, number];
  behind: [number, number];
  actions: PAction[];
  dIndex: number;
}

export interface PChance {
  kind: 'chance';
  id: number;
  children: Array<{ card: number; boardId: number; child: number }>;
}

export interface PTerminal {
  kind: 'terminal';
  id: number;
  /** fold: pot to the other player; showdown: best hand on boardId; equity: turn+river run out */
  tType: 'fold' | 'showdown' | 'equity';
  boardId: number;
  /** fold: winner (0/1) */
  winner: number;
  /**
   * utilities relative to the start of the hand for [OOP, IP]:
   * fold: [u0, u1]; showdown/equity: outcomes OOP wins, IP wins, tie -> [o * 2 + p]
   */
  utilIcm: Float64Array;
  utilChip: Float64Array;
}

export type PNode = PDecision | PChance | PTerminal;

export interface PostflopTree {
  spot: PostflopSpot;
  nodes: PNode[];
  boards: number[][];
  numDecisions: number;
}

interface State {
  street: Street;
  boardId: number;
  pot: number;
  contrib: [number, number];
  behind: [number, number];
  /** chips each player put in on earlier streets of this solve (river subtrees of a turn solve) */
  prior: [number, number];
  toAct: 0 | 1;
  raises: number;
  checked: boolean;
}

const EPS = 1e-9;
const round2 = (x: number) => Math.round(x * 100) / 100;

export function buildPostflopTree(spot: PostflopSpot): PostflopTree {
  const { icm, sizing } = spot;
  const nodes: PNode[] = [];
  const boards: number[][] = [spot.board.slice()];
  let numDecisions = 0;
  const [s0, s1] = icm.seats;
  const startIcm = icmEquity(icm.startStacks, icm.payouts);

  const utilities = (finals: Array<[number, number]>) => {
    const utilIcm = new Float64Array(finals.length * 2);
    const utilChip = new Float64Array(finals.length * 2);
    finals.forEach(([f0, f1], o) => {
      const stacks = icm.baseStacks.slice();
      stacks[s0] = f0;
      stacks[s1] = f1;
      const eq = icmEquity(stacks, icm.payouts, icm.startStacks);
      utilIcm[o * 2] = (eq[s0] - startIcm[s0]) * 100;
      utilIcm[o * 2 + 1] = (eq[s1] - startIcm[s1]) * 100;
      utilChip[o * 2] = f0 - icm.startStacks[s0];
      utilChip[o * 2 + 1] = f1 - icm.startStacks[s1];
    });
    return { utilIcm, utilChip };
  };

  /** final stacks of both players when `winner` (0, 1, or 2 = tie) takes the pot */
  const settle = (st: State, winner: number): [number, number] => {
    const inv0 = st.prior[0] + st.contrib[0];
    const inv1 = st.prior[1] + st.contrib[1];
    const matched = Math.min(inv0, inv1);
    const pot = spot.pot + 2 * matched;
    const f0 = icm.baseStacks[s0] - inv0 + (inv0 - matched);
    const f1 = icm.baseStacks[s1] - inv1 + (inv1 - matched);
    if (winner === 0) return [f0 + pot, f1];
    if (winner === 1) return [f0, f1 + pot];
    return [f0 + pot / 2, f1 + pot / 2];
  };

  const terminal = (st: State, tType: PTerminal['tType'], winner = -1): number => {
    const id = nodes.length;
    const finals = tType === 'fold' ? [settle(st, winner)] : [settle(st, 0), settle(st, 1), settle(st, 2)];
    const { utilIcm, utilChip } = utilities(finals);
    nodes.push({ kind: 'terminal', id, tType, boardId: st.boardId, winner, utilIcm, utilChip });
    return id;
  };

  const sizesFor = (st: State): SizeSet => (st.street === 'flop' ? sizing.flop : st.street === 'turn' ? sizing.turn : spot.street === 'turn' ? sizing.riverInTurn : sizing.river);

  const endOfStreet = (st: State): number => {
    const allIn = st.behind[0] <= EPS || st.behind[1] <= EPS;
    if (st.street === 'river') return terminal(st, 'showdown');
    if (st.street === 'flop') return terminal(st, 'equity');
    // turn: deal every river card
    const id = nodes.length;
    const chance: PChance = { kind: 'chance', id, children: [] };
    nodes.push(chance);
    const board = boards[st.boardId];
    for (let card = 0; card < 52; card++) {
      if (board.includes(card)) continue;
      const boardId = boards.length;
      boards.push([...board, card]);
      const next: State = {
        street: 'river',
        boardId,
        pot: st.pot,
        contrib: [0, 0],
        behind: [st.behind[0], st.behind[1]],
        prior: [st.prior[0] + st.contrib[0], st.prior[1] + st.contrib[1]],
        toAct: 0,
        raises: 0,
        checked: false,
      };
      const child = allIn ? terminal(next, 'showdown') : build(next, false);
      chance.children.push({ card, boardId, child });
    }
    return id;
  };

  const build = (st: State, root: boolean): number => {
    const id = nodes.length;
    const p = st.toAct;
    const o = (1 - p) as 0 | 1;
    const node: PDecision = {
      kind: 'decision', id, player: p, street: st.street, root, boardId: st.boardId, pot: st.pot,
      contrib: [st.contrib[0], st.contrib[1]], behind: [st.behind[0], st.behind[1]], actions: [], dIndex: numDecisions++,
    };
    nodes.push(node);
    const facing = st.contrib[o] - st.contrib[p];
    const total = st.contrib[p] + st.behind[p];
    const sizes = sizesFor(st);
    const candidates: Array<{ type: PActType; to: number }> = [];

    if (facing <= EPS) {
      candidates.push({ type: 'check', to: st.contrib[p] });
      if (st.behind[p] > EPS && st.behind[o] > EPS) {
        for (const f of sizes.bets) {
          const to = round2(st.contrib[p] + f * st.pot);
          if (to < total * sizing.allinThreshold) candidates.push({ type: 'bet', to });
        }
        if (sizes.allin) candidates.push({ type: 'allin', to: total });
      }
    } else {
      candidates.push({ type: 'fold', to: st.contrib[p] });
      candidates.push({ type: 'call', to: Math.min(st.contrib[o], total) });
      if (st.behind[o] > EPS && total > st.contrib[o] + EPS && st.raises < sizing.maxRaises) {
        const potAfterCall = st.pot + facing;
        for (const f of sizes.raises) {
          const to = round2(st.contrib[o] + f * potAfterCall);
          if (to < total * sizing.allinThreshold) candidates.push({ type: 'raise', to });
        }
        if (sizes.allin) candidates.push({ type: 'allin', to: total });
      }
    }
    // drop duplicate amounts (e.g. a bet size equal to all-in)
    const seen = new Set<string>();
    const legal = candidates.filter((c) => {
      const key = c.type === 'fold' || c.type === 'check' || c.type === 'call' ? c.type : `amt${c.to}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    for (const a of legal) {
      let child: number;
      if (a.type === 'fold') {
        child = terminal(st, 'fold', o);
      } else if (a.type === 'check') {
        if (p === 1 || st.checked) child = endOfStreet(st);
        else child = build({ ...st, contrib: [st.contrib[0], st.contrib[1]], behind: [st.behind[0], st.behind[1]], toAct: o, checked: true }, root);
      } else {
        const add = a.to - st.contrib[p];
        const contrib: [number, number] = [st.contrib[0], st.contrib[1]];
        const behind: [number, number] = [st.behind[0], st.behind[1]];
        contrib[p] = a.to;
        behind[p] = Math.max(0, behind[p] - add);
        const next: State = { ...st, contrib, behind, pot: st.pot + add, toAct: o, checked: st.checked };
        if (a.type === 'call') child = endOfStreet(next);
        else child = build({ ...next, raises: st.raises + 1 }, root);
      }
      node.actions.push({ type: a.type, to: a.to, child });
    }
    return id;
  };

  const b0 = icm.baseStacks[s0];
  const b1 = icm.baseStacks[s1];
  build(
    { street: spot.street, boardId: 0, pot: spot.pot, contrib: [0, 0], behind: [b0, b1], prior: [0, 0], toAct: 0, raises: 0, checked: false },
    true,
  );
  return { spot, nodes, boards, numDecisions };
}

export function postflopActionLabel(a: PAction, node: PDecision): string {
  const fmt = (x: number) => (Math.round(x * 10) / 10).toString();
  switch (a.type) {
    case 'check': return 'Check';
    case 'fold': return 'Fold';
    case 'call': return `Call ${fmt(a.to - node.contrib[node.player])}`;
    case 'bet': return `Bet ${fmt(a.to)} (${Math.round((a.to / node.pot) * 100)}%)`;
    case 'raise': return `Raise ${fmt(a.to)}`;
    case 'allin': return `All-in ${fmt(a.to)}`;
  }
}
