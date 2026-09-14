// Multiway showdown model.
//
// Pairwise equities alone can't give P(hero beats both opponents): wins against different
// opponents are positively correlated through the board. We model, for each hand class h, its
// strength percentile s_h(board) against a random hand, and assume P(beat range y | board) =
// s^γ_y (γ_y fitted so the board average matches the exact pairwise equity). Then
// P(beat y and z) = mean_board s^(γ_y + γ_z) = G_h(γ_y + γ_z), tabulated here.
//
// Usage: npm run gen:multiway -- [boards] [--validate]

import { writeFileSync } from 'node:fs';
import { classCombos, COMPAT, NUM_CLASSES } from '../src/engine/cards';
import { EQUITY, WIN } from '../src/engine/equity';
import { evaluate7 } from '../src/engine/evaluator';
import { gAt, GAMMA_GRID, gammaFor, multiwayFirst } from '../src/engine/multiway';

const N = NUM_CLASSES;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const combos: Array<{ c1: number; c2: number; cls: number }> = [];
for (let cls = 0; cls < N; cls++) for (const [c1, c2] of classCombos(cls)) combos.push({ c1, c2, cls });

function buildTable(boards: number, seed: number): Float32Array {
  const rand = rng(seed);
  const G = new Float64Array(N * GAMMA_GRID.length);
  const weight = new Float64Array(N);
  const seven = new Int32Array(7);
  const board = new Int32Array(5);
  const scores = new Float64Array(combos.length);
  const valid = new Uint8Array(combos.length);
  const sumU = new Float64Array(N);
  const cnt = new Float64Array(N);
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let b = 0; b < boards; b++) {
    for (let k = 0; k < 5; k++) {
      const j = k + Math.floor(rand() * (52 - k));
      [deck[k], deck[j]] = [deck[j], deck[k]];
      board[k] = deck[k];
    }
    const onBoard = new Uint8Array(52);
    for (const c of board) onBoard[c] = 1;
    let m = 0;
    for (let i = 0; i < combos.length; i++) {
      const cb = combos[i];
      valid[i] = onBoard[cb.c1] || onBoard[cb.c2] ? 0 : 1;
      if (!valid[i]) continue;
      seven[0] = cb.c1; seven[1] = cb.c2;
      for (let k = 0; k < 5; k++) seven[2 + k] = board[k];
      scores[i] = evaluate7(seven);
      m++;
    }
    // percentile of each combo among valid combos (ties count half)
    const order = [];
    for (let i = 0; i < combos.length; i++) if (valid[i]) order.push(i);
    order.sort((x, y) => scores[x] - scores[y]);
    sumU.fill(0);
    cnt.fill(0);
    for (let a = 0; a < order.length; ) {
      let e = a;
      while (e + 1 < order.length && scores[order[e + 1]] === scores[order[a]]) e++;
      const u = Math.min(1, Math.max(1e-9, (a + (e - a) / 2) / (m - 1)));
      for (let k = a; k <= e; k++) {
        const cls = combos[order[k]].cls;
        weight[cls] += 1;
        for (let g = 0; g < GAMMA_GRID.length; g++) G[cls * GAMMA_GRID.length + g] += Math.pow(u, GAMMA_GRID[g]);
      }
      a = e + 1;
    }
  }
  const out = new Float32Array(G.length);
  for (let h = 0; h < N; h++) for (let g = 0; g < GAMMA_GRID.length; g++) out[h * GAMMA_GRID.length + g] = G[h * GAMMA_GRID.length + g] / weight[h];
  return out;
}

// ---------- validation against exact multiway Monte Carlo ----------

function strengthOrder(): number[] {
  const vsRandom = Array.from({ length: N }, (_, h) => {
    let s = 0;
    for (let j = 0; j < N; j++) s += COMPAT[h * N + j] * EQUITY[h * N + j];
    return s;
  });
  return Array.from({ length: N }, (_, h) => h).sort((a, b) => vsRandom[b] - vsRandom[a]);
}

function exactMultiway(h: number, ranges: Float64Array[], samples: number, rand: () => number) {
  const heroCombos = classCombos(h);
  const cum = ranges.map((r) => {
    const c = new Float64Array(combos.length);
    let t = 0;
    for (let i = 0; i < combos.length; i++) { t += r[combos[i].cls]; c[i] = t; }
    return c;
  });
  const used = new Uint8Array(52);
  const seven = new Int32Array(7);
  let first = 0, total = 0;
  for (let s = 0; s < samples; s++) {
    used.fill(0);
    const [a, b] = heroCombos[Math.floor(rand() * heroCombos.length)];
    used[a] = 1; used[b] = 1;
    const holes: Array<[number, number]> = [[a, b]];
    let ok = true;
    for (const c of cum) {
      let pick = -1;
      for (let t = 0; t < 400; t++) {
        const x = rand() * c[c.length - 1];
        let lo = 0, hi = c.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (c[mid] > x) hi = mid; else lo = mid + 1; }
        if (!used[combos[lo].c1] && !used[combos[lo].c2]) { pick = lo; break; }
      }
      if (pick < 0) { ok = false; break; }
      used[combos[pick].c1] = 1; used[combos[pick].c2] = 1;
      holes.push([combos[pick].c1, combos[pick].c2]);
    }
    if (!ok) continue;
    const deck: number[] = [];
    for (let c = 0; c < 52; c++) if (!used[c]) deck.push(c);
    for (let k = 0; k < 5; k++) { const j = k + Math.floor(rand() * (deck.length - k)); [deck[k], deck[j]] = [deck[j], deck[k]]; }
    const sc = holes.map(([x, y]) => { seven[0] = x; seven[1] = y; for (let k = 0; k < 5; k++) seven[2 + k] = deck[k]; return evaluate7(seven); });
    const best = Math.max(...sc);
    const winners = sc.filter((v) => v === best).length;
    if (sc[0] === best) first += 1 / winners;
    total++;
  }
  return first / total;
}

function validate(table: Float32Array) {
  const order = strengthOrder();
  const scenarios = (seed: number, count: number) => {
    const rand = rng(seed);
    const makeRange = (): Float64Array => {
      const r = new Float64Array(N);
      const kind = rand();
      if (kind < 0.6) {
        const pct = [0.03, 0.08, 0.15, 0.25, 0.4, 0.6, 1][Math.floor(rand() * 7)];
        const k = Math.max(1, Math.round(N * pct));
        for (let i = 0; i < k; i++) r[order[i]] = 1;
      } else if (kind < 0.8) {
        const lo = Math.floor(rand() * 60), hi = lo + 20 + Math.floor(rand() * 60);
        for (let i = lo; i < Math.min(N, hi); i++) r[order[i]] = 1;
      } else {
        for (let h = 0; h < N; h++) r[h] = rand() < 0.3 ? rand() : 0;
        r[order[0]] = 1;
      }
      return r;
    };
    const out: Array<{ h: number; b: number[]; exact: number }> = [];
    for (let t = 0; t < count; t++) {
      const h = Math.floor(rand() * N);
      const k = rand() < 0.6 ? 2 : 3;
      const ranges = Array.from({ length: k }, makeRange);
      const b = ranges.map((r) => {
        let num = 0, den = 0;
        for (let j = 0; j < N; j++) { num += r[j] * WIN[h * N + j]; den += r[j] * COMPAT[h * N + j]; }
        return num / den;
      });
      out.push({ h, b, exact: exactMultiway(h, ranges, 20000, rand) });
    }
    return out;
  };
  const pl = (b: number[]) => 1 / (1 + b.reduce((s, x) => s + (1 - x) / Math.max(x, 1e-9), 0));
  const tempered = (h: number, b: number[], kappa: number) => {
    let gs = 0, min = 1, sum = 0;
    for (const x of b) { gs += gammaFor(table, h, x); min = Math.min(min, x); sum += x; }
    return Math.min(min, Math.max(Math.max(0, sum - (b.length - 1)), gAt(table, h, gs * kappa)));
  };
  const variants: Record<string, (h: number, b: number[]) => number> = {
    product: (_h, b) => b.reduce((x, y) => x * y, 1),
    'plackett-luce': (_h, b) => pl(b),
    percentile: (h, b) => multiwayFirst(table, h, b),
    'avg(pct, PL)': (h, b) => (multiwayFirst(table, h, b) + pl(b)) / 2,
  };
  for (const k of [0.8, 0.85, 0.9, 0.95]) variants['percentile κ=' + k] = (h, b) => tempered(h, b, k);
  const report = (name: string, data: Array<{ h: number; b: number[]; exact: number }>) => {
    console.log('--- ' + name);
    for (const [label, f] of Object.entries(variants)) {
      const parts = [2, 3].map((k) => {
        const e = data.filter((d) => d.b.length === k).map((d) => f(d.h, d.b) - d.exact);
        const mean = e.reduce((x, y) => x + y, 0) / e.length;
        const mae = e.reduce((x, y) => x + Math.abs(y), 0) / e.length;
        const max = Math.max(...e.map(Math.abs));
        return `${k + 1}인: bias ${(mean * 100).toFixed(2)} MAE ${(mae * 100).toFixed(2)} max ${(max * 100).toFixed(2)}`;
      });
      console.log(label.padEnd(20) + parts.join('  |  '));
    }
  };
  report('fit set', scenarios(777, 300));
  report('held-out set', scenarios(31337, 300));
}

const boards = Number(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 20000);
const t0 = Date.now();
const table = buildTable(boards, 4242);
console.log(`table from ${boards} boards in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (process.argv.includes('--validate')) validate(table);
else {
  const q = Uint16Array.from(table, (v) => Math.round(Math.min(1, Math.max(0, v)) * 65535));
  const b64 = Buffer.from(new Uint8Array(q.buffer)).toString('base64');
  writeFileSync(
    new URL('../src/engine/data/multiway169.ts', import.meta.url),
    `// Generated by scripts/gen-multiway.ts (${boards} boards). Do not edit.\n` +
      `// Uint16 little-endian (value/65535), [class * GAMMA_GRID.length + g] = mean over boards of s^gamma.\n` +
      `export const MULTIWAY169_B64 =\n  '${b64}';\n`,
  );
  console.log('wrote src/engine/data/multiway169.ts');
}
