import { seatNames, type SolverConfig } from './config';
import { icmEquity } from './icm';

export type ActType = 'fold' | 'check' | 'call' | 'raise' | 'allin';

export interface Action {
  type: ActType;
  /** total street contribution after the action (bb) */
  to: number;
  child: number;
}

interface NodeBase {
  id: number;
  parent: number;
  /** action index taken from parent */
  parentAction: number;
  pot: number;
  contrib: number[];
  behind: number[];
  folded: boolean[];
  allin: boolean[];
}

export interface DecisionNode extends NodeBase {
  kind: 'decision';
  player: number;
  bet: number;
  actions: Action[];
  /** index into per-decision arrays (0..numDecisions-1) */
  dIndex: number;
}

export type TerminalType = 'fold' | 'showdown' | 'flop';

export interface TerminalNode extends NodeBase {
  kind: 'terminal';
  tType: TerminalType;
  /** seats still in the hand, ordered by postflop action order (first to act first) */
  participants: number[];
  /**
   * fold: [[winner]]; showdown: every strict ranking of participants (best first);
   * flop: [[winner]] for each participant
   */
  outcomes: number[][];
  /** utilIcm[o * numPlayers + seat], in % of prize pool relative to the start of the hand */
  utilIcm: Float64Array;
  /** chip result in bb relative to the start of the hand */
  utilChip: Float64Array;
  /** flop only: equity realization factor per participant (same order as participants) */
  eqr: number[];
  /** flop only: scale for hand playability adjustments */
  playScale: number;
}

export type TreeNode = DecisionNode | TerminalNode;

export interface GameTree {
  numPlayers: number;
  seatNames: string[];
  nodes: TreeNode[];
  numDecisions: number;
  /** ICM equity (% of pool) of each seat at the start of the hand */
  startIcm: number[];
  config: SolverConfig;
}

interface State {
  contrib: number[];
  behind: number[];
  folded: boolean[];
  allin: boolean[];
  acted: boolean[];
  matched: boolean[];
  voluntary: boolean[];
  bet: number;
  level: number;
  limped: boolean;
  lastRaiser: number;
  betIsAllin: boolean;
}

const EPS = 1e-9;
const MAX_NODES = 400_000;

function cloneState(s: State): State {
  return {
    contrib: s.contrib.slice(),
    behind: s.behind.slice(),
    folded: s.folded.slice(),
    allin: s.allin.slice(),
    acted: s.acted.slice(),
    matched: s.matched.slice(),
    voluntary: s.voluntary.slice(),
    bet: s.bet,
    level: s.level,
    limped: s.limped,
    lastRaiser: s.lastRaiser,
    betIsAllin: s.betIsAllin,
  };
}

export function postflopRank(seat: number, n: number): number {
  if (n === 2) return seat === 0 ? 1 : 0; // heads-up: SB is the button
  return seat >= n - 2 ? seat - (n - 2) : seat + 2;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function buildTree(config: SolverConfig): GameTree {
  const n = config.stacks.length;
  if (n < 2 || n > 8) throw new Error('2~8명만 지원합니다');
  const SB = n - 2;
  const BB = n - 1;
  const start = config.stacks.slice();
  const anteOf = (seat: number) => (seat === BB ? Math.min(config.ante, start[seat]) : 0);
  const payTotal = config.payouts.reduce((a, b) => a + b, 0) || 1;
  const payouts = config.payouts.map((p) => p / payTotal);
  const startIcmRaw = icmEquity(start, payouts);
  const startIcm = Array.from(startIcmRaw, (x) => x * 100);
  const sz = config.sizing;

  const init: State = {
    contrib: new Array(n).fill(0),
    behind: start.slice(),
    folded: new Array(n).fill(false),
    allin: new Array(n).fill(false),
    acted: new Array(n).fill(false),
    matched: new Array(n).fill(false),
    voluntary: new Array(n).fill(false),
    bet: config.bb,
    level: 0,
    limped: false,
    lastRaiser: BB,
    betIsAllin: false,
  };
  const post = (seat: number, amt: number) => {
    const a = Math.min(amt, init.behind[seat]);
    init.contrib[seat] += a;
    init.behind[seat] -= a;
    if (init.behind[seat] <= EPS) init.allin[seat] = true;
  };
  init.behind[BB] -= anteOf(BB);
  post(SB, config.sb);
  post(BB, config.bb);

  const nodes: TreeNode[] = [];
  let numDecisions = 0;

  const needsAct = (s: State, j: number) => !s.folded[j] && !s.allin[j] && (!s.acted[j] || s.contrib[j] < s.bet - EPS);
  const nextToAct = (s: State, from: number): number => {
    for (let k = 1; k <= n; k++) {
      const j = (from + k) % n;
      if (needsAct(s, j)) return j;
    }
    return -1;
  };
  const potOf = (s: State) => s.contrib.reduce((a, b) => a + b, 0) + anteOf(BB);

  const finalStacksBase = (s: State) => start.map((st, j) => st - anteOf(j) - s.contrib[j]);

  const utilities = (finals: number[][]) => {
    const utilIcm = new Float64Array(finals.length * n);
    const utilChip = new Float64Array(finals.length * n);
    finals.forEach((f, o) => {
      const eq = icmEquity(f, payouts, start);
      for (let j = 0; j < n; j++) {
        utilIcm[o * n + j] = eq[j] * 100 - startIcm[j];
        utilChip[o * n + j] = f[j] - start[j];
      }
    });
    return { utilIcm, utilChip };
  };

  const makeTerminal = (s: State, parent: number, parentAction: number): number => {
    const id = nodes.length;
    const participants: number[] = [];
    for (let j = 0; j < n; j++) if (!s.folded[j]) participants.push(j);
    participants.sort((a, b) => postflopRank(a, n) - postflopRank(b, n));
    const pot = potOf(s);
    const base = {
      id, parent, parentAction, pot,
      contrib: s.contrib.slice(), behind: s.behind.slice(), folded: s.folded.slice(), allin: s.allin.slice(),
    };
    let tType: TerminalType;
    let outcomes: number[][];
    let finals: number[][];
    let eqr: number[] = [];
    let playScale = 1;

    if (participants.length === 1) {
      tType = 'fold';
      outcomes = [[participants[0]]];
      const f = finalStacksBase(s);
      f[participants[0]] += pot;
      finals = [f];
    } else {
      const withChips = participants.filter((j) => !s.allin[j]).length;
      const anyAllin = participants.some((j) => s.allin[j]);
      if (anyAllin || withChips <= 1) {
        if (participants.length > 3) throw new Error('트리 규칙 오류: 4인 이상 올인 쇼다운이 생성되었습니다');
        tType = 'showdown';
        outcomes = permutations(participants);
        finals = outcomes.map((order) => {
          const f = finalStacksBase(s);
          const win = distributeSidePots(s.contrib, s.folded, anteOf(BB), order);
          for (let j = 0; j < n; j++) f[j] += win[j];
          return f;
        });
      } else {
        tType = 'flop';
        const k = participants.length;
        const minBehind = Math.min(...participants.map((j) => s.behind[j]));
        const x = Math.min(config.postflop.potGrowth * pot, minBehind);
        outcomes = participants.map((w) => [w]);
        finals = participants.map((w) => {
          const f = finalStacksBase(s);
          for (const j of participants) f[j] -= x;
          f[w] += pot + x * k;
          return f;
        });
        const spr = minBehind / pot;
        const shrink = Math.min(1, Math.max(0.25, spr / 6));
        const bases = config.postflop.eqrByPlayers[k] ?? new Array(k).fill(1);
        // the last preflop raiser realizes more (initiative); a limped pot has no aggressor
        const agg = s.level > 0 && participants.includes(s.lastRaiser) ? s.lastRaiser : -1;
        const factors = config.postflop.aggressor ?? { ip: 1, oop: 1 };
        const g = agg < 0 ? 1 : participants[k - 1] === agg ? factors.ip : factors.oop;
        eqr = participants.map((j, r) => (1 + ((bases[r] ?? 1) - 1) * shrink) * (j === agg ? 1 + (g - 1) * shrink : 1));
        playScale = Math.min(1.25, Math.max(0.25, spr / 8)) * config.postflop.playability;
      }
    }
    const { utilIcm, utilChip } = utilities(finals);
    nodes.push({ ...base, kind: 'terminal', tType, participants, outcomes, utilIcm, utilChip, eqr, playScale });
    return id;
  };

  const inHandCount = (s: State, except: number) => {
    let c = 0;
    for (let j = 0; j < n; j++) if (j !== except && !s.folded[j] && (s.matched[j] || s.allin[j])) c++;
    return c;
  };

  const legalActions = (s: State, i: number): Array<{ type: ActType; to: number }> => {
    const out: Array<{ type: ActType; to: number }> = [];
    const total = s.contrib[i] + s.behind[i];
    const facing = s.bet - s.contrib[i];
    const cold = !s.voluntary[i];
    const isBlind = i === SB || i === BB;

    if (facing > EPS) out.push({ type: 'fold', to: s.contrib[i] });
    else out.push({ type: 'check', to: s.contrib[i] });

    if (facing > EPS) {
      const callAllin = facing >= s.behind[i] - EPS;
      let allowed: boolean;
      if (config.pushFoldOnly) allowed = s.betIsAllin || callAllin;
      else if (s.level === 0) allowed = i === SB && config.allowLimp;
      else if (s.level === 1) allowed = isBlind || !cold || config.allowColdCall || s.betIsAllin;
      else allowed = !cold || s.betIsAllin;
      if (allowed) {
        const after = inHandCount(s, i) + 1;
        let limit = 3;
        if (!callAllin && after === 4) {
          const noAllin = !s.allin.some((a, j) => a && !s.folded[j]);
          if (noAllin) {
            const t = cloneState(s);
            t.contrib[i] = t.bet;
            t.acted[i] = true;
            if (nextToAct(t, i) < 0) limit = 4;
          }
        }
        if (after <= limit) out.push({ type: 'call', to: Math.min(s.bet, total) });
      }
    }

    const opponentsWithChips = s.folded.some((f, j) => j !== i && !f && !s.allin[j]);
    // all-in players can't fold any more, so a raise on top of three of them forces a 4-way pot
    let allinOthers = 0;
    for (let j = 0; j < n; j++) if (j !== i && !s.folded[j] && s.allin[j]) allinOthers++;
    if (total > s.bet + EPS && opponentsWithChips && allinOthers + 1 <= 3) {
      if (!config.pushFoldOnly) {
        let to = -1;
        if (s.level === 0) {
          if (s.limped) to = sz.iso;
          else to = i === SB && n > 2 ? sz.sbOpen : sz.open;
        } else if (s.level === 1) {
          const ip = postflopRank(i, n) > postflopRank(s.lastRaiser, n);
          let callers = 0;
          for (let j = 0; j < n; j++) if (j !== s.lastRaiser && !s.folded[j] && s.matched[j]) callers++;
          to = s.bet * (ip ? sz.threeBetIP : sz.threeBetOOP) + sz.squeezePerCaller * s.bet * callers;
        } else if (s.level === 2 && !cold) {
          to = s.bet * sz.fourBet;
        }
        to = round2(to);
        if (to > s.bet + EPS && to < total * sz.allinThreshold) out.push({ type: 'raise', to });
      }
      if (!config.pushFoldOnly || s.level === 0 || s.betIsAllin) out.push({ type: 'allin', to: total });
    }
    return out;
  };

  const applyAction = (s: State, i: number, a: { type: ActType; to: number }): State => {
    const t = cloneState(s);
    t.acted[i] = true;
    switch (a.type) {
      case 'fold':
        t.folded[i] = true;
        break;
      case 'check':
        t.matched[i] = true;
        break;
      case 'call': {
        const amt = Math.min(t.bet - t.contrib[i], t.behind[i]);
        t.contrib[i] += amt;
        t.behind[i] -= amt;
        if (t.behind[i] <= EPS) { t.behind[i] = 0; t.allin[i] = true; }
        t.matched[i] = true;
        t.voluntary[i] = true;
        if (t.level === 0) t.limped = true;
        break;
      }
      case 'raise':
      case 'allin': {
        const amt = a.to - t.contrib[i];
        t.contrib[i] = a.to;
        t.behind[i] -= amt;
        if (t.behind[i] <= EPS) { t.behind[i] = 0; t.allin[i] = true; }
        t.bet = a.to;
        t.level++;
        t.matched.fill(false);
        t.matched[i] = true;
        t.voluntary[i] = true;
        t.lastRaiser = i;
        t.betIsAllin = t.allin[i];
        break;
      }
    }
    return t;
  };

  const build = (s: State, player: number, parent: number, parentAction: number): number => {
    if (nodes.length > MAX_NODES) throw new Error(`트리가 너무 큽니다 (>${MAX_NODES} 노드). 사이즈 옵션을 줄여주세요.`);
    const id = nodes.length;
    const legal = legalActions(s, player);
    const node: DecisionNode = {
      kind: 'decision', id, parent, parentAction, player, bet: s.bet, pot: potOf(s),
      contrib: s.contrib.slice(), behind: s.behind.slice(), folded: s.folded.slice(), allin: s.allin.slice(),
      actions: [], dIndex: numDecisions++,
    };
    nodes.push(node);
    legal.forEach((a, ai) => {
      const t = applyAction(s, player, a);
      const alive = t.folded.filter((f) => !f).length;
      const next = alive <= 1 ? -1 : nextToAct(t, player);
      const child = next < 0 ? makeTerminal(t, id, ai) : build(t, next, id, ai);
      node.actions.push({ type: a.type, to: a.to, child });
    });
    return id;
  };

  const first = nextToAct(init, n - 1);
  build(init, first, -1, -1);

  return { numPlayers: n, seatNames: seatNames(n), nodes, numDecisions, startIcm, config };
}

function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr.slice()];
  const out: T[][] = [];
  arr.forEach((x, i) => {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) out.push([x, ...p]);
  });
  return out;
}

/** Chips won by each seat for a given strict ranking of the non-folded players (best first). */
export function distributeSidePots(contrib: number[], folded: boolean[], deadMoney: number, order: number[]): number[] {
  const n = contrib.length;
  const win = new Array(n).fill(0);
  const levels = Array.from(new Set(order.map((j) => contrib[j]))).sort((a, b) => a - b);
  let prev = 0;
  levels.forEach((level, li) => {
    let layer = li === 0 ? deadMoney : 0;
    for (let j = 0; j < n; j++) layer += Math.min(contrib[j], level) - Math.min(contrib[j], prev);
    const winner = order.find((j) => contrib[j] >= level - EPS && !folded[j])!;
    win[winner] += layer;
    prev = level;
  });
  // folded money above the highest live level (cannot normally happen) goes to the best hand
  let leftover = 0;
  for (let j = 0; j < n; j++) leftover += Math.max(0, contrib[j] - prev);
  if (leftover > EPS) win[order[0]] += leftover;
  return win;
}

export function actionLabel(a: Action, node: DecisionNode): string {
  switch (a.type) {
    case 'fold': return 'Fold';
    case 'check': return 'Check';
    case 'call': return node.bet <= 1 + EPS && node.contrib[node.player] < 1 ? 'Limp' : `Call ${fmtBB(a.to)}`;
    case 'raise': return `Raise ${fmtBB(a.to)}`;
    case 'allin': return `All-in ${fmtBB(a.to)}`;
  }
}

export function fmtBB(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(x < 10 ? 2 : 1).replace(/0+$/, '').replace(/\.$/, '');
}
