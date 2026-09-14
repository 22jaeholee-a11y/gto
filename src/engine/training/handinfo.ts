// Plain-language facts about a hand: made hand, draws, equity against a range.

import { COMBOS, COMPAT, NUM_CLASSES } from '../cards';
import { EQUITY, WIN } from '../equity';
import { BoardEvaluator } from '../evaluator';
import { COMBO_C1, COMBO_C2, NC } from '../postflop/combos';

const RANK_NAMES = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const CAT = 1 << 20;

export function rankName(r: number): string {
  return RANK_NAMES[r];
}

/** preflop strength order: share of all combos that are at least as strong (by equity vs a random hand) */
export const PREFLOP_PERCENTILE: Float64Array = (() => {
  const N = NUM_CLASSES;
  const vsRandom = Array.from({ length: N }, (_, h) => {
    let s = 0;
    for (let j = 0; j < N; j++) s += COMPAT[h * N + j] * EQUITY[h * N + j];
    return s;
  });
  const order = Array.from({ length: N }, (_, h) => h).sort((a, b) => vsRandom[b] - vsRandom[a]);
  const out = new Float64Array(N);
  let cum = 0;
  for (const h of order) {
    cum += COMBOS[h];
    out[h] = cum / 1326;
  }
  return out;
})();

export interface PreflopFeatures {
  pair: boolean;
  suited: boolean;
  connected: boolean;
  hasAce: boolean;
  hasKing: boolean;
  label: string;
}

export function preflopFeatures(cls: number): PreflopFeatures {
  const r = Math.floor(cls / 13), c = cls % 13;
  const hi = 12 - Math.min(r, c), lo = 12 - Math.max(r, c);
  const pair = r === c, suited = r < c;
  const connected = !pair && hi - lo <= 2;
  let label = pair ? '포켓페어' : suited ? (connected ? '수티드 커넥터' : '수티드') : connected ? '오프수트 커넥터' : '오프수트';
  if (!pair && hi === 12) label = suited ? '수티드 에이스' : '오프수트 에이스';
  return { pair, suited, connected, hasAce: hi === 12, hasKing: hi === 11 || lo === 11, label };
}

/** preflop all-in equity of a class against class-level reach weights */
export function preflopEquityVsRange(cls: number, reach: ArrayLike<number>): number | null {
  const N = NUM_CLASSES;
  let num = 0, den = 0;
  for (let j = 0; j < N; j++) {
    const w = reach[j];
    if (!(w > 0)) continue;
    num += w * WIN[cls * N + j];
    den += w * COMPAT[cls * N + j];
  }
  return den > 0 ? num / den : null;
}

/** share of all 1326 combos in a class-level range */
export function rangeShare(reach: ArrayLike<number>): number {
  let s = 0;
  for (let j = 0; j < NUM_CLASSES; j++) s += COMBOS[j] * Math.max(0, reach[j]);
  return s / 1326;
}

export interface MadeHand {
  category: number;
  made: string;
  draws: string[];
}

/** made hand and draws of hole cards on a 3-5 card board */
export function describeHand(hole: [number, number], board: number[]): MadeHand {
  const be = new BoardEvaluator(board);
  const score = be.eval2(hole[0], hole[1]);
  const category = Math.floor(score / CAT);
  const boardRanks = board.map((c) => c >> 2).sort((a, b) => b - a);
  const h1 = hole[0] >> 2, h2 = hole[1] >> 2;
  const top = boardRanks[0];
  let made: string;
  switch (category) {
    case 0:
      made = `하이카드 ${rankName(Math.max(h1, h2))}`;
      break;
    case 1: {
      if (h1 === h2) made = h1 > top ? `오버페어 (${rankName(h1)})` : `포켓페어 (${rankName(h1)}, 보드 아래)`;
      else {
        const p = boardRanks.includes(h1) ? h1 : boardRanks.includes(h2) ? h2 : -1;
        if (p < 0) made = '보드 페어 (내 카드는 하이카드)';
        else {
          const kicker = p === h1 ? h2 : h1;
          const unique = Array.from(new Set(boardRanks));
          if (p === unique[0]) made = `탑페어 (${rankName(kicker)} 키커)`;
          else if (p === unique[1]) made = '세컨드 페어';
          else made = '약한 페어';
        }
      }
      break;
    }
    case 2:
      made = boardRanks.includes(h1) && boardRanks.includes(h2) && h1 !== h2 ? '투페어' : '투페어 (보드 페어 포함)';
      break;
    case 3:
      made = h1 === h2 && boardRanks.includes(h1) ? '셋' : '트립스';
      break;
    case 4: made = '스트레이트'; break;
    case 5: made = '플러시'; break;
    case 6: made = '풀하우스'; break;
    case 7: made = '포카드'; break;
    default: made = '스트레이트 플러시';
  }

  const draws: string[] = [];
  if (board.length < 5 && category < 4) {
    // flush draw: four of a suit using at least one hole card
    for (let s = 0; s < 4; s++) {
      const holeIn = [hole[0], hole[1]].filter((c) => (c & 3) === s);
      const count = board.filter((c) => (c & 3) === s).length + holeIn.length;
      if (count === 4 && holeIn.length > 0) {
        const nut = holeIn.some((c) => c >> 2 === 12);
        draws.push(nut ? '넛 플러시 드로우' : '플러시 드로우');
      }
    }
    // straight draws: missing single ranks that complete a straight, using a hole card
    const mask = (cards: number[]) => {
      let m = 0;
      // bit r+1 for rank r, and bit 0 for an ace playing low (wheel)
      for (const c of cards) m |= 1 << ((c >> 2) + 1);
      if (m & (1 << 13)) m |= 1;
      return m;
    };
    const outs = (m: number) => {
      const res = new Set<number>();
      for (let hi = 4; hi <= 13; hi++) {
        const window = 0b11111 << (hi - 4);
        const missing = window & ~m;
        if (missing && (missing & (missing - 1)) === 0) res.add(missing);
      }
      return res;
    };
    const withHole = outs(mask([...board, ...hole]));
    const boardOnly = outs(mask(board));
    const mine = [...withHole].filter((x) => !boardOnly.has(x));
    if (mine.length >= 2) draws.push('양방 스트레이트 드로우');
    else if (mine.length === 1) draws.push('거트샷');
  }
  return { category, made, draws };
}

/**
 * Equity of the hero's hole cards against a combo-weighted range on a 3-5 card board.
 * Rivers and turns are enumerated; on the flop the run-outs are subsampled.
 */
export function equityVsRange(hole: [number, number], board: number[], range: Float64Array): number | null {
  const dead = new Uint8Array(52);
  for (const c of board) dead[c] = 1;
  dead[hole[0]] = 1;
  dead[hole[1]] = 1;
  const villain: number[] = [];
  const weight: number[] = [];
  for (let k = 0; k < NC; k++) {
    const w = range[k];
    if (!(w > 1e-9) || dead[COMBO_C1[k]] || dead[COMBO_C2[k]]) continue;
    villain.push(k);
    weight.push(w);
  }
  if (villain.length === 0) return null;
  const deck: number[] = [];
  for (let c = 0; c < 52; c++) if (!dead[c]) deck.push(c);
  const need = 5 - board.length;
  const runouts: number[][] = [];
  if (need === 0) runouts.push([]);
  else if (need === 1) for (const c of deck) runouts.push([c]);
  else {
    for (let i = 0; i < deck.length; i++) for (let j = i + 1; j < deck.length; j++) runouts.push([deck[i], deck[j]]);
  }
  const stride = need === 2 ? Math.max(1, Math.floor(runouts.length / 300)) : 1;
  const be = new BoardEvaluator();
  let win = 0, total = 0;
  for (let r = 0; r < runouts.length; r += stride) {
    const ro = runouts[r];
    be.setBoard([...board, ...ro]);
    const mine = be.eval2(hole[0], hole[1]);
    for (let v = 0; v < villain.length; v++) {
      const k = villain[v];
      const a = COMBO_C1[k], b = COMBO_C2[k];
      if (ro.includes(a) || ro.includes(b)) continue;
      const theirs = be.eval2(a, b);
      const w = weight[v];
      total += w;
      if (mine > theirs) win += w;
      else if (mine === theirs) win += w / 2;
    }
  }
  return total > 0 ? win / total : null;
}

/** share of a combo-weighted range holding two pair or better on the current board */
export function strongShare(range: Float64Array, board: number[]): number | null {
  const dead = new Uint8Array(52);
  for (const c of board) dead[c] = 1;
  const be = new BoardEvaluator(board);
  let strong = 0, total = 0;
  for (let k = 0; k < NC; k++) {
    const w = range[k];
    if (!(w > 1e-9) || dead[COMBO_C1[k]] || dead[COMBO_C2[k]]) continue;
    total += w;
    if (Math.floor(be.eval2(COMBO_C1[k], COMBO_C2[k]) / CAT) >= 2) strong += w;
  }
  return total > 0 ? strong / total : null;
}

/** where a combo's current made-hand strength sits inside a combo-weighted range (0 = best) */
export function strengthPercentile(hole: [number, number], board: number[], range: Float64Array): number | null {
  const dead = new Uint8Array(52);
  for (const c of board) dead[c] = 1;
  const be = new BoardEvaluator(board);
  const mine = be.eval2(hole[0], hole[1]);
  let better = 0, total = 0;
  for (let k = 0; k < NC; k++) {
    const w = range[k];
    if (!(w > 1e-9) || dead[COMBO_C1[k]] || dead[COMBO_C2[k]]) continue;
    total += w;
    const s = be.eval2(COMBO_C1[k], COMBO_C2[k]);
    if (s > mine) better += w;
    else if (s === mine) better += w / 2;
  }
  return total > 0 ? better / total : null;
}
