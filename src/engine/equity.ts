import { COMPAT, NUM_CLASSES } from './cards';
import { EQUITY169_B64 } from './data/equity169';
import { REMOVAL169_B64, REMOVAL_SCALE } from './data/removal169';

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** EQUITY[h * 169 + j] = all-in equity of class h vs class j (ties count half). */
export const EQUITY: Float64Array = (() => {
  const bytes = decodeBase64(EQUITY169_B64);
  const q = new Uint16Array(bytes.buffer, bytes.byteOffset, NUM_CLASSES * NUM_CLASSES);
  const out = new Float64Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = q[i] / 65535;
  return out;
})();

/** WIN[h * 169 + j] = COMPAT * EQUITY: card-removal-weighted share of j combos that h beats. */
export const WIN: Float64Array = (() => {
  const out = new Float64Array(NUM_CLASSES * NUM_CLASSES);
  for (let i = 0; i < out.length; i++) out[i] = COMPAT[i] * EQUITY[i];
  return out;
})();

/**
 * DEAD_WIN[h * 169 + j] = COMPAT * d(equity)/d(dead broadway card): how much more of class j's
 * combos class h beats when one folded player's card is a broadway card instead of a lower one.
 */
export const DEAD_WIN: Float64Array = (() => {
  const bytes = decodeBase64(REMOVAL169_B64);
  const q = new Int16Array(bytes.buffer, bytes.byteOffset, NUM_CLASSES * NUM_CLASSES);
  const out = new Float64Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = (COMPAT[i] * q[i]) / REMOVAL_SCALE;
  return out;
})();

/** broadway cards (T-A) in each class, and the expectation for a random hand */
export const BROADWAY: Float64Array = Float64Array.from({ length: NUM_CLASSES }, (_, i) => {
  const r = Math.floor(i / 13), c = i % 13;
  return (r <= 4 ? 1 : 0) + (c <= 4 ? 1 : 0);
});
export const BROADWAY_RANDOM = (2 * 20) / 52;

/** out[h] = sum_j M[h*169+j] * v[j] */
export function matVec(M: Float64Array, v: Float64Array, out: Float64Array): void {
  const N = NUM_CLASSES;
  // gather non-zero columns once; deep-tree ranges are sparse
  let nnz = 0;
  const idx = NZ_IDX;
  for (let j = 0; j < N; j++) if (v[j] !== 0) idx[nnz++] = j;
  if (nnz === 0) { out.fill(0); return; }
  for (let h = 0; h < N; h++) {
    const base = h * N;
    let s = 0;
    for (let k = 0; k < nnz; k++) { const j = idx[k]; s += M[base + j] * v[j]; }
    out[h] = s;
  }
}
const NZ_IDX = new Int32Array(NUM_CLASSES);

/** out1 = A·v and out2 = B·v in one pass over the non-zero entries of v */
export function matVec2(A: Float64Array, B: Float64Array, v: Float64Array, out1: Float64Array, out2: Float64Array): void {
  const N = NUM_CLASSES;
  let nnz = 0;
  const idx = NZ_IDX;
  for (let j = 0; j < N; j++) if (v[j] !== 0) idx[nnz++] = j;
  if (nnz === 0) { out1.fill(0); out2.fill(0); return; }
  for (let h = 0; h < N; h++) {
    const base = h * N;
    let s1 = 0, s2 = 0;
    for (let k = 0; k < nnz; k++) {
      const j = idx[k];
      const x = v[j];
      s1 += A[base + j] * x;
      s2 += B[base + j] * x;
    }
    out1[h] = s1;
    out2[h] = s2;
  }
}
