// The 1326 two-card combos, card helpers and board utilities for postflop solving.
// Card = rank * 4 + suit, rank 0..12 = 2..A, suit 0..3 = c d h s.

import { classCombos, NUM_CLASSES } from '../cards';

export const NC = 1326;

export const COMBO_C1 = new Uint8Array(NC);
export const COMBO_C2 = new Uint8Array(NC);
/** hand class (0..168, same indexing as the preflop chart) of each combo */
export const COMBO_CLASS = new Uint8Array(NC);
/** COMBO_INDEX[c1 * 52 + c2] (either order) = combo index */
export const COMBO_INDEX = new Int16Array(52 * 52).fill(-1);
/** combos grouped by class */
export const CLASS_COMBOS: number[][] = Array.from({ length: NUM_CLASSES }, () => []);

(() => {
  let k = 0;
  for (let cls = 0; cls < NUM_CLASSES; cls++) {
    for (const [a, b] of classCombos(cls)) {
      COMBO_C1[k] = a;
      COMBO_C2[k] = b;
      COMBO_CLASS[k] = cls;
      COMBO_INDEX[a * 52 + b] = k;
      COMBO_INDEX[b * 52 + a] = k;
      CLASS_COMBOS[cls].push(k);
      k++;
    }
  }
})();

const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';
export const SUIT_SYMBOLS = ['♣', '♦', '♥', '♠'];

export function cardRank(c: number): string {
  return RANKS[c >> 2];
}

export function cardSuit(c: number): number {
  return c & 3;
}

export function cardText(c: number): string {
  return RANKS[c >> 2] + SUITS[c & 3];
}

export function parseCard(s: string): number {
  return RANKS.indexOf(s[0].toUpperCase()) * 4 + SUITS.indexOf(s[1].toLowerCase());
}

export function comboText(k: number): string {
  // higher rank first
  const a = COMBO_C1[k], b = COMBO_C2[k];
  return a >= b ? cardText(a) + cardText(b) : cardText(b) + cardText(a);
}

export function boardMask(board: ArrayLike<number>): bigint {
  let m = 0n;
  for (let i = 0; i < board.length; i++) m |= 1n << BigInt(board[i]);
  return m;
}

/** true if combo k shares a card with the given cards */
export function comboBlocked(k: number, cards: ArrayLike<number>): boolean {
  const a = COMBO_C1[k], b = COMBO_C2[k];
  for (let i = 0; i < cards.length; i++) if (cards[i] === a || cards[i] === b) return true;
  return false;
}

/** expand a 169-class weight vector to combos, zeroing combos that conflict with dead cards */
export function classToCombos(classWeights: ArrayLike<number>, dead: ArrayLike<number>): Float64Array {
  const out = new Float64Array(NC);
  for (let k = 0; k < NC; k++) out[k] = comboBlocked(k, dead) ? 0 : classWeights[COMBO_CLASS[k]];
  return out;
}
