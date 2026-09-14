import { COMBOS, NUM_CLASSES } from '../engine/cards';
import type { SolveResult } from '../engine/solver';
import { actionLabel, type Action } from '../engine/tree';
import type { LightDecision, LightNode, LightTree } from '../worker/protocol';

const N = NUM_CLASSES;

export interface TrailStep {
  node: LightDecision;
  action: number;
}

export function walkPath(tree: LightTree, path: number[]): { node: LightNode; trail: TrailStep[] } {
  let node = tree.nodes[0];
  const trail: TrailStep[] = [];
  for (const a of path) {
    if (node.kind !== 'decision' || !node.actions[a]) break;
    trail.push({ node, action: a });
    node = tree.nodes[node.actions[a].child];
  }
  return { node, trail };
}

/** Per-combo probability that `player` reaches the end of the trail with each class. */
export function playerReach(result: SolveResult, trail: TrailStep[], player: number): Float64Array {
  const r = new Float64Array(N).fill(1);
  for (const { node, action } of trail) {
    if (node.player !== player) continue;
    const off = result.offsets[node.dIndex] + action * N;
    for (let h = 0; h < N; h++) r[h] *= result.strategy[off + h];
  }
  return r;
}

export function freqOf(result: SolveResult, node: LightDecision, action: number, h: number): number {
  return result.strategy[result.offsets[node.dIndex] + action * N + h];
}

export function evOf(arr: Float32Array, result: SolveResult, node: LightDecision, action: number, h: number): number {
  return arr[result.offsets[node.dIndex] + action * N + h];
}

/** Share of the acting player's (reach-weighted) range taking each action. */
export function actionTotals(result: SolveResult, node: LightDecision, reach: Float64Array): { freq: number[]; combos: number[] } {
  const A = node.actions.length;
  const freq = new Array(A).fill(0);
  let total = 0;
  for (let h = 0; h < N; h++) {
    const w = COMBOS[h] * reach[h];
    total += w;
    for (let a = 0; a < A; a++) freq[a] += w * freqOf(result, node, a, h);
  }
  return { combos: freq.slice(), freq: freq.map((f) => (total > 0 ? f / total : 0)) };
}

export function label(action: Action, node: LightDecision): string {
  return actionLabel(action, node);
}

/** rank of a raise among the node's sized raises (0 = smallest) for coloring */
export function raiseRank(node: LightDecision, a: number): number {
  const raises = node.actions.map((x, i) => ({ x, i })).filter(({ x }) => x.type === 'raise').sort((p, q) => p.x.to - q.x.to);
  return Math.max(0, raises.findIndex(({ i }) => i === a));
}

/** Follow fold actions from the current node until `seat` is to act. */
export function foldThrough(tree: LightTree, path: number[], seat: number): number[] | null {
  const next = path.slice();
  let { node } = walkPath(tree, next);
  for (let guard = 0; guard < 16; guard++) {
    if (node.kind !== 'decision') return null;
    if (node.player === seat) return next;
    const fold = node.actions.findIndex((a) => a.type === 'fold');
    if (fold < 0) return null;
    next.push(fold);
    node = tree.nodes[node.actions[fold].child];
  }
  return null;
}
