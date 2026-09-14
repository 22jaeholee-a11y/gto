// Malmuth-Harville ICM via subset DP: O(2^n * n).

/**
 * @param stacks  final chip stacks (0 = busted)
 * @param payouts payout per finishing place (index 0 = 1st); missing places pay 0
 * @param startStacks stacks at the start of the hand; players busting in the same hand
 *        finish in order of starting stack (equal starting stacks split the places)
 */
export function icmEquity(stacks: ArrayLike<number>, payouts: ArrayLike<number>, startStacks?: ArrayLike<number>): Float64Array {
  const n = stacks.length;
  const pay = (k: number) => (k < payouts.length ? payouts[k] : 0);
  const eq = new Float64Array(n);

  const alive: number[] = [];
  const busted: number[] = [];
  for (let i = 0; i < n; i++) (stacks[i] > 1e-9 ? alive : busted).push(i);

  // busted players take the bottom places
  if (busted.length > 0) {
    const start = startStacks ?? stacks;
    busted.sort((a, b) => start[b] - start[a]);
    let place = alive.length;
    for (let g = 0; g < busted.length; ) {
      let e = g;
      while (e + 1 < busted.length && Math.abs(start[busted[e + 1]] - start[busted[g]]) < 1e-9) e++;
      let sum = 0;
      for (let k = g; k <= e; k++) sum += pay(place + k - g);
      for (let k = g; k <= e; k++) eq[busted[k]] = sum / (e - g + 1);
      place += e - g + 1;
      g = e + 1;
    }
  }

  const m = alive.length;
  if (m === 0) return eq;
  if (m === 1) { eq[alive[0]] += pay(0); return eq; }

  const s = alive.map((i) => stacks[i]);
  const total = s.reduce((a, b) => a + b, 0);
  const size = 1 << m;
  const prob = new Float64Array(size); // P(set S occupies exactly the top |S| places)
  const sumS = new Float64Array(size);
  const bits = new Uint8Array(size);
  prob[0] = 1;
  for (let S = 1; S < size; S++) {
    const low = S & -S;
    const idx = 31 - Math.clz32(low);
    sumS[S] = sumS[S ^ low] + s[idx];
    bits[S] = bits[S ^ low] + 1;
  }
  for (let S = 0; S < size; S++) {
    const p = prob[S];
    if (p === 0) continue;
    const remaining = total - sumS[S];
    if (remaining <= 1e-12) continue;
    const place = bits[S];
    const pv = pay(place);
    for (let i = 0; i < m; i++) {
      const bit = 1 << i;
      if (S & bit) continue;
      const q = (p * s[i]) / remaining;
      prob[S | bit] += q;
      eq[alive[i]] += q * pv;
    }
  }
  return eq;
}
