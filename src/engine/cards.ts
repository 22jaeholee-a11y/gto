// Card = rank * 4 + suit, rank 0..12 = 2..A.
// Hand class grid: row/col 0..12 where 0 = Ace. idx = row * 13 + col.
// row == col: pair, row < col: suited (upper-right), row > col: offsuit.

export const NUM_CLASSES = 169;
export const RANK_CHARS = 'AKQJT98765432';

export function classLabel(idx: number): string {
  const r = Math.floor(idx / 13);
  const c = idx % 13;
  if (r === c) return RANK_CHARS[r] + RANK_CHARS[c];
  if (r < c) return RANK_CHARS[r] + RANK_CHARS[c] + 's';
  return RANK_CHARS[c] + RANK_CHARS[r] + 'o';
}

export function classCombos(idx: number): Array<[number, number]> {
  const r = Math.floor(idx / 13);
  const c = idx % 13;
  const hi = 12 - Math.min(r, c);
  const lo = 12 - Math.max(r, c);
  const out: Array<[number, number]> = [];
  if (r === c) {
    for (let s1 = 0; s1 < 4; s1++)
      for (let s2 = s1 + 1; s2 < 4; s2++) out.push([hi * 4 + s1, hi * 4 + s2]);
  } else if (r < c) {
    for (let s = 0; s < 4; s++) out.push([hi * 4 + s, lo * 4 + s]);
  } else {
    for (let s1 = 0; s1 < 4; s1++)
      for (let s2 = 0; s2 < 4; s2++) if (s1 !== s2) out.push([hi * 4 + s1, lo * 4 + s2]);
  }
  return out;
}

/** Number of combos per class (6 / 4 / 12). */
export const COMBOS: Float64Array = (() => {
  const a = new Float64Array(NUM_CLASSES);
  for (let i = 0; i < NUM_CLASSES; i++) a[i] = classCombos(i).length;
  return a;
})();

const CLASS_R1 = new Int8Array(NUM_CLASSES);
const CLASS_R2 = new Int8Array(NUM_CLASSES);
/** combos of class j that contain one specific card of rank r1 (resp. r2) */
const CARD_HITS = new Float64Array(NUM_CLASSES);
for (let i = 0; i < NUM_CLASSES; i++) {
  const r = Math.floor(i / 13), c = i % 13;
  CLASS_R1[i] = Math.min(r, c);
  CLASS_R2[i] = Math.max(r, c);
  CARD_HITS[i] = r === c ? 3 : r < c ? 1 : 3;
}
const RANK_ROW = new Float64Array(13);

/**
 * Fast exact COMPAT · x via inclusion-exclusion over cards:
 * mass(a,b) = total - row(a) - row(b) + x[class(a,b)], where row(card) sums the weight
 * of combos containing that card (depends only on its rank for suit-symmetric ranges).
 */
export function compatMul(x: Float64Array, out: Float64Array): void {
  RANK_ROW.fill(0);
  let total = 0;
  for (let j = 0; j < NUM_CLASSES; j++) {
    const v = x[j];
    if (v === 0) continue;
    total += v * COMBOS[j];
    const hits = v * CARD_HITS[j];
    RANK_ROW[CLASS_R1[j]] += hits;
    if (CLASS_R2[j] !== CLASS_R1[j]) RANK_ROW[CLASS_R2[j]] += hits;
  }
  for (let h = 0; h < NUM_CLASSES; h++) {
    out[h] = (total - RANK_ROW[CLASS_R1[h]] - RANK_ROW[CLASS_R2[h]] + x[h]) / 1225;
  }
}

/**
 * COMPAT[h * 169 + j] = expected number of class-j combos that don't share a card
 * with a given combo of class h, divided by 1225 (= C(50,2)). A full range therefore
 * has mass 1 against any hero hand.
 */
export const COMPAT: Float64Array = (() => {
  const m = new Float64Array(NUM_CLASSES * NUM_CLASSES);
  const combos = Array.from({ length: NUM_CLASSES }, (_, i) => classCombos(i));
  for (let h = 0; h < NUM_CLASSES; h++) {
    for (let j = 0; j < NUM_CLASSES; j++) {
      let n = 0;
      for (const [a, b] of combos[h])
        for (const [c, d] of combos[j]) if (a !== c && a !== d && b !== c && b !== d) n++;
      m[h * NUM_CLASSES + j] = n / combos[h].length / 1225;
    }
  }
  return m;
})();
