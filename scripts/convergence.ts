// Local convergence check: EV lost at individual spots by the average strategy vs a best response
// (using the solver's own EVs). Usage: node .audit/convergence.mjs
import { COMBOS, NUM_CLASSES } from '../src/engine/cards';
import { DEFAULT_CONFIG, seatNames } from '../src/engine/config';
import { DCFR, finalize, Solver } from '../src/engine/solver';
import { buildTree, type ActType, type DecisionNode, type GameTree } from '../src/engine/tree';

const N = NUM_CLASSES;
const spots: Array<[string, Array<[string, ActType]>, string]> = [
  ['UTG RFI', [], 'UTG'],
  ['BTN RFI', [], 'BTN'],
  ['BB vs BTN open', [['BTN', 'raise']], 'BB'],
  ['BB vs BTN shove', [['BTN', 'allin']], 'BB'],
  ['SB vs BTN shove', [['BTN', 'allin']], 'SB'],
  ['BTN vs CO open', [['CO', 'raise']], 'BTN'],
  ['CO vs BTN 3bet', [['CO', 'raise'], ['BTN', 'raise']], 'CO'],
  ['SB vs BB iso', [['SB', 'call'], ['BB', 'raise']], 'SB'],
];

function pathTo(tree: GameTree, steps: Array<[string, ActType]>, at: string) {
  const names = seatNames(tree.numPlayers);
  const path: number[] = [];
  let node = tree.nodes[0] as DecisionNode;
  const foldTo = (seat: number) => {
    while (node.player !== seat) {
      const f = node.actions.findIndex((a) => a.type === 'fold');
      path.push(f);
      node = tree.nodes[node.actions[f].child] as DecisionNode;
    }
  };
  for (const [seat, type] of steps) {
    foldTo(names.indexOf(seat));
    const a = node.actions.findIndex((x) => x.type === type);
    path.push(a);
    node = tree.nodes[node.actions[a].child] as DecisionNode;
  }
  foldTo(names.indexOf(at));
  return path;
}

function localLoss(tree: GameTree, res: ReturnType<typeof finalize>, path: number[]) {
  let node = tree.nodes[0] as DecisionNode;
  const steps: Array<[DecisionNode, number]> = [];
  for (const a of path) { steps.push([node, a]); node = tree.nodes[node.actions[a].child] as DecisionNode; }
  const reach = new Float64Array(N).fill(1);
  for (const [nd, a] of steps) if (nd.player === node.player) for (let h = 0; h < N; h++) reach[h] *= res.strategy[res.offsets[nd.dIndex] + a * N + h];
  const off = res.offsets[node.dIndex];
  const ev = tree.config.mode === 'icm' ? res.evIcm : res.evChip;
  let loss = 0, w = 0, worst = 0;
  for (let h = 0; h < N; h++) {
    const cw = COMBOS[h] * reach[h];
    if (cw < 1e-9) continue;
    let best = -Infinity, cur = 0;
    for (let a = 0; a < node.actions.length; a++) {
      const e = ev[off + a * N + h];
      if (!Number.isFinite(e)) continue;
      best = Math.max(best, e);
      cur += res.strategy[off + a * N + h] * e;
    }
    if (!Number.isFinite(best)) continue;
    loss += cw * (best - cur); w += cw;
    if (reach[h] > 0.05) worst = Math.max(worst, best - cur);
  }
  return `${(loss / w).toFixed(4)}/${worst.toFixed(3)}`;
}

const total = Number(process.env.TOTAL ?? 800);
const tree = buildTree({ ...DEFAULT_CONFIG, iterations: total });
const paths = spots.map(([, steps, at]) => pathTo(tree, steps, at));
const variants = process.argv.slice(2);
for (const v of variants.length ? variants : ['default']) {
  const gamma = v;
  const solver = new Solver(tree);
  const checkpoints = [total];
  for (const cp of checkpoints) {
    solver.run(cp - solver.iterations);
    const res = finalize(solver);
    console.log(`γ=${gamma} it=${cp} expl=${res.exploitability.toFixed(4)} | ` + spots.map(([name], i) => `${name} ${localLoss(tree, res, paths[i])}`).join(' | '));
  }
}
