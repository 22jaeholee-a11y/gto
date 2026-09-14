// Multiway win probability from pairwise equities (model and validation: scripts/gen-multiway.ts).
//
// For hero class h against ranges with exact pairwise equities b_i, P(h beats all of them) =
// G_h(κ · Σ γ_i) where G_h(γ) = E_board[s_h^γ] (s_h = combo percentile vs a random hand) and γ_i
// solves G_h(γ_i) = b_i. κ corrects the residual under-estimate measured on held-out scenarios.

import { NUM_CLASSES } from './cards';
import { MULTIWAY169_B64 } from './data/multiway169';

/** exponents at which G_h(γ) is tabulated (log-spaced) */
export const GAMMA_GRID: Float64Array = (() => {
  const n = 96;
  const lo = Math.log(0.02), hi = Math.log(80);
  return Float64Array.from({ length: n }, (_, i) => Math.exp(lo + ((hi - lo) * i) / (n - 1)));
})();
const G = GAMMA_GRID.length;
const LOG_LO = Math.log(GAMMA_GRID[0]);
const LOG_STEP = (Math.log(GAMMA_GRID[G - 1]) - LOG_LO) / (G - 1);

/** κ by number of opponents (index), fitted on held-out exact multiway Monte Carlo */
export const KAPPA = [1, 1, 0.95, 0.92];

let decoded: Float64Array | null = null;

/** the bundled table, decoded on first use */
export function multiwayTable(): Float64Array {
  if (decoded) return decoded;
  const bin = atob(MULTIWAY169_B64);
  if (bin.length !== NUM_CLASSES * G * 2) throw new Error('multiway table missing: run npm run gen:multiway');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  decoded = Float64Array.from(new Uint16Array(bytes.buffer), (v) => v / 65535);
  return decoded;
}

/** G_h at an arbitrary γ via linear interpolation in log γ (clamped to the grid). */
export function gAt(table: ArrayLike<number>, h: number, gamma: number): number {
  const base = h * G;
  if (gamma <= GAMMA_GRID[0]) return table[base];
  if (gamma >= GAMMA_GRID[G - 1]) return table[base + G - 1];
  const x = (Math.log(gamma) - LOG_LO) / LOG_STEP;
  const i = Math.min(G - 2, Math.floor(x));
  const f = x - i;
  return table[base + i] * (1 - f) + table[base + i + 1] * f;
}

/** γ with G_h(γ) = b (G is decreasing in γ). */
export function gammaFor(table: ArrayLike<number>, h: number, b: number): number {
  const base = h * G;
  if (b >= table[base]) return GAMMA_GRID[0];
  if (b <= table[base + G - 1]) return GAMMA_GRID[G - 1];
  let lo = 0, hi = G - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[base + mid] > b) lo = mid; else hi = mid;
  }
  const a = table[base + lo], c = table[base + hi];
  const f = a === c ? 0 : (a - b) / (a - c);
  return Math.exp(LOG_LO + (lo + f) * LOG_STEP);
}

/**
 * P(hero class h beats every opponent) given pairwise equities b[i] against each range,
 * clamped to the Fréchet bounds so it stays a valid joint probability.
 */
export function multiwayFirst(table: ArrayLike<number>, h: number, b: ArrayLike<number>): number {
  if (b.length === 1) return b[0];
  let gammaSum = 0, min = 1, sum = 0;
  for (let i = 0; i < b.length; i++) {
    const bi = Math.min(1, Math.max(0, b[i]));
    gammaSum += gammaFor(table, h, bi);
    min = Math.min(min, bi);
    sum += bi;
  }
  const lower = Math.max(0, sum - (b.length - 1));
  const v = gAt(table, h, gammaSum * (KAPPA[b.length] ?? KAPPA[KAPPA.length - 1]));
  return Math.min(min, Math.max(lower, v));
}

const INV_BINS = 2048;
let inverse: Float64Array | null = null;

/** γ as a function of b on a uniform grid, so the solver's inner loop avoids binary searches */
function inverseTable(): Float64Array {
  if (inverse) return inverse;
  const table = multiwayTable();
  const inv = new Float64Array(NUM_CLASSES * (INV_BINS + 1));
  for (let h = 0; h < NUM_CLASSES; h++)
    for (let k = 0; k <= INV_BINS; k++) inv[h * (INV_BINS + 1) + k] = gammaFor(table, h, k / INV_BINS);
  inverse = inv;
  return inv;
}

function gammaFast(inv: Float64Array, h: number, b: number): number {
  const x = Math.min(1, Math.max(0, b)) * INV_BINS;
  const i = Math.min(INV_BINS - 1, x | 0);
  const f = x - i;
  const base = h * (INV_BINS + 1);
  return inv[base + i] * (1 - f) + inv[base + i + 1] * f;
}

// G_h resampled on a uniform grid in u = γ^(1/4), so lookups need two square roots instead of a log
const U_BINS = 1024;
const U_LO = Math.sqrt(Math.sqrt(GAMMA_GRID[0]));
const U_HI = Math.sqrt(Math.sqrt(GAMMA_GRID[G - 1]));
const U_STEP = (U_HI - U_LO) / U_BINS;
let uTable: Float64Array | null = null;

function quarticTable(): Float64Array {
  if (uTable) return uTable;
  const table = multiwayTable();
  const out = new Float64Array(NUM_CLASSES * (U_BINS + 1));
  for (let h = 0; h < NUM_CLASSES; h++)
    for (let k = 0; k <= U_BINS; k++) {
      const u = U_LO + k * U_STEP;
      out[h * (U_BINS + 1) + k] = gAt(table, h, u * u * u * u);
    }
  uTable = out;
  return out;
}

function gFast(tbl: Float64Array, h: number, gamma: number): number {
  const x = (Math.sqrt(Math.sqrt(gamma)) - U_LO) / U_STEP;
  const base = h * (U_BINS + 1);
  if (x <= 0) return tbl[base];
  if (x >= U_BINS) return tbl[base + U_BINS];
  const i = x | 0;
  const f = x - i;
  return tbl[base + i] * (1 - f) + tbl[base + i + 1] * f;
}

/** multiwayFirst on the bundled table with 1-3 opponents (b2/b3 < 0 = absent), allocation free */
export function firstVs(h: number, b1: number, b2 = -1, b3 = -1): number {
  if (b2 < 0) return b1;
  const inv = inverseTable();
  let gs = gammaFast(inv, h, b1) + gammaFast(inv, h, b2);
  let min = Math.min(b1, b2), sum = b1 + b2, opp = 2;
  if (b3 >= 0) { gs += gammaFast(inv, h, b3); min = Math.min(min, b3); sum += b3; opp = 3; }
  const v = gFast(quarticTable(), h, gs * KAPPA[opp]);
  return Math.min(min, Math.max(0, sum - (opp - 1), v));
}
