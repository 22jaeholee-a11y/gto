import type { ChanceExecutor, ChanceItem, PostflopPass, PostflopUtil } from './solver';
import { PostflopSolver } from './solver';
import type { PostflopTree } from './tree';

/** river cards dealt at the chance nodes of a turn tree */
export function riverCards(tree: PostflopTree): number[] {
  for (const nd of tree.nodes) if (nd.kind === 'chance') return nd.children.map((c) => c.card);
  return [];
}

export function hasChance(tree: PostflopTree): boolean {
  return tree.nodes.some((nd) => nd.kind === 'chance');
}

/** split river cards into `parts` groups */
export function splitCards(cards: number[], parts: number): number[][] {
  const groups: number[][] = Array.from({ length: Math.max(1, Math.min(parts, cards.length)) }, () => []);
  cards.forEach((c, i) => groups[i % groups.length].push(c));
  return groups;
}

/** Groups chance items by owning part and reassembles the results. */
export async function dispatchItems(
  items: ChanceItem[],
  groups: number[][],
  runPart: (part: number, items: ChanceItem[]) => Promise<Float64Array[]>,
): Promise<Map<number, Float64Array>> {
  const partOf = new Map<number, number>();
  groups.forEach((cards, i) => cards.forEach((c) => partOf.set(c, i)));
  const byPart: ChanceItem[][] = groups.map(() => []);
  for (const it of items) byPart[partOf.get(it.card)!].push(it);
  const outs = await Promise.all(byPart.map((list, i) => (list.length ? runPart(i, list) : Promise.resolve([]))));
  const results = new Map<number, Float64Array>();
  byPart.forEach((list, i) => list.forEach((it, k) => results.set(it.key, outs[i][k])));
  return results;
}

/** Runs river subtrees in-process (tests, and devices without workers). */
export class LocalChanceExecutor implements ChanceExecutor {
  private workers: PostflopSolver[];
  private groups: number[][];

  constructor(tree: PostflopTree, ranges: [Float64Array, Float64Array], parts: number) {
    this.groups = splitCards(riverCards(tree), parts);
    this.workers = this.groups.map((cards) => new PostflopSolver(tree, ranges, { role: 'worker', cards }));
  }

  run(p: 0 | 1, pass: PostflopPass, util: PostflopUtil, t: number, items: ChanceItem[]): Promise<Map<number, Float64Array>> {
    return dispatchItems(items, this.groups, async (part, list) => this.workers[part].runItems(p, pass, util, t, list));
  }
}
