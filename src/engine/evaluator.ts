// 7-card hand evaluator. Returns a score where higher is better.
// Score = category * 2^20 + tiebreak ranks packed in 4-bit nibbles.

const STRAIGHT_HIGH = new Int8Array(1 << 13); // highest rank of best straight in mask, -1 if none

(() => {
  for (let mask = 0; mask < 1 << 13; mask++) {
    let best = -1;
    for (let hi = 12; hi >= 4; hi--) {
      const need = 0b11111 << (hi - 4);
      if ((mask & need) === need) { best = hi; break; }
    }
    // wheel A-2-3-4-5
    if (best < 0 && (mask & 0b1000000001111) === 0b1000000001111) best = 3;
    STRAIGHT_HIGH[mask] = best;
  }
})();

function topBits(mask: number, n: number): number {
  let out = 0;
  let got = 0;
  for (let r = 12; r >= 0 && got < n; r--) {
    if (mask & (1 << r)) { out = (out << 4) | r; got++; }
  }
  return out;
}

const CAT = 1 << 20;

export function evaluate7(cards: ArrayLike<number>): number {
  const suitMask = [0, 0, 0, 0];
  const counts = new Int8Array(13);
  let rankMask = 0;
  for (let i = 0; i < 7; i++) {
    const c = cards[i];
    const r = c >> 2;
    suitMask[c & 3] |= 1 << r;
    counts[r]++;
    rankMask |= 1 << r;
  }
  for (let s = 0; s < 4; s++) {
    const m = suitMask[s];
    if (popcount(m) >= 5) {
      const sh = STRAIGHT_HIGH[m];
      if (sh >= 0) return 8 * CAT + sh;
      return 5 * CAT + topBits(m, 5);
    }
  }
  let quad = -1, trip1 = -1, trip2 = -1, pair1 = -1, pair2 = -1;
  for (let r = 12; r >= 0; r--) {
    const n = counts[r];
    if (n === 4) quad = r;
    else if (n === 3) { if (trip1 < 0) trip1 = r; else if (trip2 < 0) trip2 = r; }
    else if (n === 2) { if (pair1 < 0) pair1 = r; else if (pair2 < 0) pair2 = r; }
  }
  if (quad >= 0) return 7 * CAT + (quad << 4) + topBits(rankMask & ~(1 << quad), 1);
  if (trip1 >= 0 && (trip2 >= 0 || pair1 >= 0)) {
    const p = Math.max(trip2, pair1);
    return 6 * CAT + (trip1 << 4) + p;
  }
  const sh = STRAIGHT_HIGH[rankMask];
  if (sh >= 0) return 4 * CAT + sh;
  if (trip1 >= 0) return 3 * CAT + (trip1 << 8) + topBits(rankMask & ~(1 << trip1), 2);
  if (pair1 >= 0 && pair2 >= 0)
    return 2 * CAT + (pair1 << 8) + (pair2 << 4) + topBits(rankMask & ~(1 << pair1) & ~(1 << pair2), 1);
  if (pair1 >= 0) return 1 * CAT + (pair1 << 12) + topBits(rankMask & ~(1 << pair1), 3);
  return topBits(rankMask, 5);
}

function popcount(x: number): number {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  return (((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
