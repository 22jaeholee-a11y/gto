// Parallel DCFR: with simultaneous updates, subtrees below a frontier are independent within an
// iteration given the reach vectors at their roots. The coordinator owns the top of the tree,
// executors own the subtrees; one iteration = collect reach at frontier -> run subtrees -> apply.

import { NUM_CLASSES } from './cards';
import { exploitabilityOf, finalize, rootValues, Solver, type FrontierItem, type Pass, type SolveResult } from './solver';
import type { GameTree } from './tree';

const N = NUM_CLASSES;

export interface PartitionPlan {
  frontier: number[];
  /** frontier node ids per executor */
  assignment: number[][];
}

export interface PartExport {
  dIndex: Int32Array;
  strategy: Float32Array;
  evIcm: Float32Array;
  evChip: Float32Array;
}

export interface SubtreeExecutor {
  run(part: number, pass: Pass, util: 'icm' | 'chip', t: number, ids: Int32Array, reach: Float64Array, store: boolean): Promise<Float64Array>;
  exportPart(part: number): Promise<PartExport>;
}

/** estimated work per subtree: showdowns with more players and fold removal dominate the cost */
export function subtreeSizes(tree: GameTree): Float64Array {
  const size = new Float64Array(tree.nodes.length);
  for (let i = tree.nodes.length - 1; i >= 0; i--) {
    const nd = tree.nodes[i];
    if (nd.kind === 'decision') {
      size[i] = 2 * nd.actions.length;
      for (const a of nd.actions) size[i] += size[a.child];
    } else if (nd.tType === 'fold') {
      size[i] = 1;
    } else {
      size[i] = nd.participants.length === 2 ? 4 : 12;
    }
  }
  return size;
}

export function planPartition(tree: GameTree, parts: number, minDecisions = 1500): PartitionPlan | null {
  if (parts <= 1 || tree.numDecisions < minDecisions) return null;
  const size = subtreeSizes(tree);
  const total = size[0];
  const target = total / (parts * 4);
  let frontier = [0];
  for (let guard = 0; guard < 2000; guard++) {
    let bi = -1;
    for (let i = 0; i < frontier.length; i++) if (size[frontier[i]] > target && (bi < 0 || size[frontier[i]] > size[frontier[bi]])) bi = i;
    if (bi < 0) break;
    const nd = tree.nodes[frontier[bi]];
    if (nd.kind !== 'decision') break;
    const kids = nd.actions.map((a) => a.child).filter((c) => tree.nodes[c].kind === 'decision');
    frontier = frontier.slice(0, bi).concat(kids, frontier.slice(bi + 1));
  }
  if (frontier.includes(0) || frontier.length === 0) return null;
  const load = new Array(parts).fill(0);
  const assignment: number[][] = Array.from({ length: parts }, () => []);
  for (const id of frontier.slice().sort((a, b) => size[b] - size[a])) {
    let w = 0;
    for (let i = 1; i < parts; i++) if (load[i] < load[w]) w = i;
    assignment[w].push(id);
    load[w] += size[id];
  }
  return { frontier, assignment: assignment.filter((a) => a.length > 0) };
}

export function exportPart(solver: Solver, evIcm: Float32Array, evChip: Float32Array): PartExport {
  return {
    dIndex: Int32Array.from(solver.owned, (nd) => nd.dIndex),
    strategy: solver.averageStrategy(),
    evIcm,
    evChip,
  };
}

export class Coordinator {
  readonly tree: GameTree;
  readonly plan: PartitionPlan;
  readonly top: Solver;
  private exec: SubtreeExecutor;
  private partOf = new Map<number, number>();
  iteration = 0;
  /** cumulative milliseconds per phase, for diagnosing parallel overhead */
  readonly timing = { collect: 0, workers: 0, apply: 0, slowest: 0 };

  constructor(tree: GameTree, plan: PartitionPlan, exec: SubtreeExecutor) {
    this.tree = tree;
    this.plan = plan;
    this.exec = exec;
    this.top = new Solver(tree, { roots: [0], frontier: plan.frontier });
    plan.assignment.forEach((ids, p) => ids.forEach((id) => this.partOf.set(id, p)));
  }

  private async pass(pass: Pass, util: 'icm' | 'chip', store?: Float32Array): Promise<Float64Array> {
    const n = this.tree.numPlayers;
    this.top.iterations = this.iteration;
    const t0 = performance.now();
    const items = this.top.collectFrontier(pass, util);
    const t1 = performance.now();
    const groups: FrontierItem[][] = this.plan.assignment.map(() => []);
    for (const it of items) groups[this.partOf.get(it.id)!].push(it);
    const partMs: number[] = [];
    const outs = await Promise.all(
      groups.map((g, p) => {
        const ts = performance.now();
        const ids = Int32Array.from(g, (x) => x.id);
        const reach = new Float64Array(g.length * n * N);
        g.forEach((x, i) => reach.set(x.reach, i * n * N));
        return this.exec.run(p, pass, util, this.iteration, ids, reach, store !== undefined).then((r) => {
          partMs[p] = performance.now() - ts;
          return r;
        });
      }),
    );
    const t2 = performance.now();
    const results = new Map<number, Float64Array>();
    groups.forEach((g, p) => g.forEach((x, i) => results.set(x.id, outs[p].subarray(i * n * N, (i + 1) * n * N))));
    const root = this.top.applyFrontier(pass, util, results, store);
    const t3 = performance.now();
    this.timing.collect += t1 - t0;
    this.timing.workers += t2 - t1;
    this.timing.apply += t3 - t2;
    this.timing.slowest += Math.max(...partMs) - partMs.reduce((a, b) => a + b, 0) / partMs.length;
    return root;
  }

  async run(count: number): Promise<void> {
    for (let k = 0; k < count; k++) {
      this.iteration++;
      await this.pass('train', this.tree.config.mode);
    }
  }

  async exploitability(): Promise<number> {
    const util = this.tree.config.mode;
    const n = this.tree.numPlayers;
    const ev = rootValues(await this.pass('ev', util), n);
    const br = rootValues(await this.pass('br', util), n);
    return exploitabilityOf(ev, br);
  }

  async finalize(expl?: number): Promise<SolveResult> {
    const tree = this.tree;
    const n = tree.numPlayers;
    const offsets = new Int32Array(tree.numDecisions);
    const actionsOf = new Int32Array(tree.numDecisions);
    let off = 0;
    for (const nd of tree.nodes) {
      if (nd.kind !== 'decision') continue;
      offsets[nd.dIndex] = off;
      actionsOf[nd.dIndex] = nd.actions.length;
      off += nd.actions.length * N;
    }
    const strategy = new Float32Array(off);
    const evIcm = new Float32Array(off);
    const evChip = new Float32Array(off);

    const topIcm = new Float32Array(this.top.stratSum.length);
    const topChip = new Float32Array(this.top.stratSum.length);
    const rootIcm = rootValues(await this.pass('ev', 'icm', topIcm), n);
    const rootChip = rootValues(await this.pass('ev', 'chip', topChip), n);
    const exploitability = expl ?? (await this.exploitability());

    const merge = (part: PartExport) => {
      let local = 0;
      for (const d of part.dIndex) {
        const len = actionsOf[d] * N;
        strategy.set(part.strategy.subarray(local, local + len), offsets[d]);
        evIcm.set(part.evIcm.subarray(local, local + len), offsets[d]);
        evChip.set(part.evChip.subarray(local, local + len), offsets[d]);
        local += len;
      }
    };
    merge(exportPart(this.top, topIcm, topChip));
    for (let p = 0; p < this.plan.assignment.length; p++) merge(await this.exec.exportPart(p));

    if ((tree.config.smoothing ?? 0) > 0) {
      // softening needs every node's EV each round: run it on one full solver seeded with the merged strategy
      const full = new Solver(tree);
      for (const nd of tree.nodes) {
        if (nd.kind !== 'decision') continue;
        const from = offsets[nd.dIndex];
        full.stratSum.set(strategy.subarray(from, from + nd.actions.length * N), full.offsets[nd.dIndex]);
      }
      const res = finalize(full);
      return { ...res, iterations: this.iteration };
    }
    return { offsets, strategy, evIcm, evChip, rootIcm, rootChip, exploitability, iterations: this.iteration };
  }
}

/** Runs subtree solvers in-process (tests, or environments without workers). */
export class LocalExecutor implements SubtreeExecutor {
  private solvers: Solver[];
  private stores: Array<{ icm: Float32Array; chip: Float32Array }>;

  constructor(tree: GameTree, plan: PartitionPlan) {
    this.solvers = plan.assignment.map((roots) => new Solver(tree, { roots }));
    this.stores = this.solvers.map((s) => ({ icm: new Float32Array(s.stratSum.length), chip: new Float32Array(s.stratSum.length) }));
  }

  async run(part: number, pass: Pass, util: 'icm' | 'chip', t: number, ids: Int32Array, reach: Float64Array, store: boolean) {
    const st = store ? this.stores[part][util] : undefined;
    return this.solvers[part].runSubtrees(pass, util, t, ids, reach, st);
  }

  async exportPart(part: number) {
    return exportPart(this.solvers[part], this.stores[part].icm, this.stores[part].chip);
  }
}
