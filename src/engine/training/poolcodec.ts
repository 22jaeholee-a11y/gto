// Compact storage for a solved preflop strategy (pre-built scenario pool).
//
// Every frequency is stored as a 12-bit log-scaled code. EVs deep in the tree depend on products of many
// small frequencies, so relative precision matters more than absolute precision: an 8-bit linear code moved
// some rarely reached EVs by several %p, the log code keeps every EV within ~0.01%p.
// Layout: 16-byte header, then the high 4 bits of every code, then the low 8 bits (separate planes gzip
// much better). Codes run over decision nodes in dIndex order, actions, then the 169 hand classes.
// EVs are not stored: they are recomputed from the strategy after download.

import { NUM_CLASSES } from '../cards';
import type { GameTree } from '../tree';

const N = NUM_CLASSES;
const MAGIC = 0x34504349; // "ICP4" little-endian
const Q = 4095;
/** frequencies below ~1/K are stored with absolute rather than relative precision */
const K = 1e9;
const LOG_K = Math.log1p(K);

/** checksum of the tree shape, so files built by a different tree builder are rejected */
export function treeSignature(tree: GameTree): number {
  let h = 2166136261;
  for (const nd of tree.nodes) {
    if (nd.kind !== 'decision') continue;
    h ^= nd.actions.length + nd.player * 16;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function decisionsInOrder(tree: GameTree) {
  const out = new Array(tree.numDecisions);
  for (const nd of tree.nodes) if (nd.kind === 'decision') out[nd.dIndex] = nd;
  return out as Array<Extract<GameTree['nodes'][number], { kind: 'decision' }>>;
}

function layout(tree: GameTree) {
  const nodes = decisionsInOrder(tree);
  const offsets = new Int32Array(tree.numDecisions);
  let total = 0;
  for (const nd of nodes) {
    offsets[nd.dIndex] = total;
    total += nd.actions.length * N;
  }
  return { nodes, offsets, total };
}

export function encodeStrategy(tree: GameTree, offsets: Int32Array, strategy: Float32Array): Uint8Array {
  const { nodes, total } = layout(tree);
  const out = new Uint8Array(16 + total * 2);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, tree.numDecisions, true);
  view.setUint32(8, total, true);
  view.setUint32(12, treeSignature(tree), true);
  let i = 0;
  for (const nd of nodes) {
    const off = offsets[nd.dIndex];
    const count = nd.actions.length * N;
    for (let k = 0; k < count; k++, i++) {
      const p = strategy[off + k];
      const q = Math.min(Q, Math.max(0, Math.round((Math.log1p(p * K) / LOG_K) * Q)));
      out[16 + i] = q >> 8;
      out[16 + total + i] = q & 255;
    }
  }
  return out;
}

export function decodeStrategy(tree: GameTree, bytes: Uint8Array): { offsets: Int32Array; strategy: Float32Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 16 || view.getUint32(0, true) !== MAGIC) throw new Error('시나리오 파일 형식이 올바르지 않습니다');
  const { nodes, offsets, total } = layout(tree);
  if (view.getUint32(4, true) !== tree.numDecisions || view.getUint32(8, true) !== total
    || view.getUint32(12, true) !== treeSignature(tree) || bytes.byteLength !== 16 + total * 2)
    throw new Error('시나리오 파일이 현재 엔진 버전과 맞지 않습니다');
  const table = new Float64Array(Q + 1);
  for (let q = 0; q <= Q; q++) table[q] = Math.expm1((q / Q) * LOG_K) / K;
  const strategy = new Float32Array(total);
  for (let i = 0; i < total; i++) strategy[i] = table[(bytes[16 + i] << 8) | bytes[16 + total + i]];
  // re-normalize every hand's frequencies (rounding leaves sums slightly off 1)
  for (const nd of nodes) {
    const A = nd.actions.length;
    const off = offsets[nd.dIndex];
    for (let h = 0; h < N; h++) {
      let sum = 0;
      for (let a = 0; a < A; a++) sum += strategy[off + a * N + h];
      for (let a = 0; a < A; a++) strategy[off + a * N + h] = sum > 0 ? strategy[off + a * N + h] / sum : 1 / A;
    }
  }
  return { offsets, strategy };
}

/** true for data that still carries a gzip header (static hosts may or may not decode it for us) */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}
