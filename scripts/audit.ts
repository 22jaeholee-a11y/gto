// Accuracy audit: solve a set of spots and compare solver EVs with the Monte Carlo reference.
// Usage: npm run audit [-- --samples 40000 --iterations 400 --only 4,5]

import { availableParallelism } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { classLabel, COMBOS, NUM_CLASSES } from '../src/engine/cards';
import { DEFAULT_CONFIG, seatNames, type SolverConfig } from '../src/engine/config';
import { referenceHand, type FoldedMode, type HandReference } from '../src/engine/reference';
import { finalize, Solver, type SolveResult } from '../src/engine/solver';
import { actionLabel, buildTree, type ActType, type DecisionNode, type GameTree } from '../src/engine/tree';

const N = NUM_CLASSES;
const FOLDED_MODE = ((): FoldedMode => {
  const i = process.argv.indexOf('--folded');
  return i >= 0 ? (process.argv[i + 1] as FoldedMode) : 'range';
})();

const NEUTRAL_POSTFLOP = {
  eqrByPlayers: { 2: [1, 1], 3: [1, 1, 1], 4: [1, 1, 1, 1] },
  aggressor: { ip: 1, oop: 1 },
  potGrowth: 0,
  playability: 0,
};

interface SpotDef {
  name: string;
  config: Partial<SolverConfig>;
  steps: Array<[string, ActType]>;
  at: string;
}

const FT = [30, 20, 14, 10, 8, 7, 6, 5];
const BUBBLE = [30, 20, 15, 12, 9, 7, 7];
const UNEVEN = [7, 30, 45, 22, 60, 18, 35, 25];

const SPOTS: SpotDef[] = [
  { name: '8인 25bb FT · UTG 첫 액션 (포스트플랍 중립)', config: { postflop: NEUTRAL_POSTFLOP }, steps: [], at: 'UTG' },
  { name: '8인 25bb FT · BB vs BTN 2bb 오픈 (포스트플랍 중립)', config: { postflop: NEUTRAL_POSTFLOP }, steps: [['BTN', 'raise']], at: 'BB' },
  { name: '8인 25bb FT · BB vs CO 오픈 + BTN 콜 (멀티웨이, 중립)', config: { postflop: NEUTRAL_POSTFLOP }, steps: [['CO', 'raise'], ['BTN', 'call']], at: 'BB' },
  { name: '8인 25bb FT · BB vs BTN 올인', config: {}, steps: [['BTN', 'allin']], at: 'BB' },
  { name: '8인 25bb FT · SB vs BTN 올인 (BB 대기)', config: {}, steps: [['BTN', 'allin']], at: 'SB' },
  { name: '스택 편차 FT · CO vs UTG 7bb 올인 (뒤에 4명)', config: { stacks: UNEVEN }, steps: [['UTG', 'allin']], at: 'CO' },
  { name: '버블(7명 지급) 스택 편차 · BB 60bb vs SB 40bb 올인', config: { stacks: [20, 15, 25, 12, 30, 18, 40, 60], payouts: BUBBLE }, steps: [['SB', 'allin']], at: 'BB' },
  { name: 'Chip EV 8인 25bb · BB vs BTN 올인', config: { mode: 'chip' }, steps: [['BTN', 'allin']], at: 'BB' },
  { name: '8인 25bb FT · SB 첫 액션 (포스트플랍 중립)', config: { postflop: NEUTRAL_POSTFLOP }, steps: [], at: 'SB' },
  { name: '8인 25bb FT · BTN vs CO 오픈 (포스트플랍 중립)', config: { postflop: NEUTRAL_POSTFLOP }, steps: [['CO', 'raise']], at: 'BTN' },
  { name: 'HU 10bb Chip EV 푸시/폴드 · SB', config: { stacks: [10, 10], ante: 0, pushFoldOnly: true, mode: 'chip', payouts: [1] }, steps: [], at: 'SB' },
];

function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

function makeConfig(def: SpotDef, iterations: number): SolverConfig {
  // the audit checks the raw solver maths against the Monte Carlo reference, so no smoothing
  return { ...DEFAULT_CONFIG, payouts: FT, smoothing: 0, ...def.config, iterations };
}

function findPath(tree: GameTree, def: SpotDef): number[] {
  const names = seatNames(tree.numPlayers);
  const path: number[] = [];
  let node = tree.nodes[0];
  const foldTo = (seat: number) => {
    for (let g = 0; g < 20; g++) {
      if (node.kind !== 'decision') throw new Error(`${def.name}: reached terminal`);
      if (node.player === seat) return;
      const f = node.actions.findIndex((a) => a.type === 'fold');
      if (f < 0) throw new Error(`${def.name}: cannot fold ${names[node.player]}`);
      path.push(f);
      node = tree.nodes[node.actions[f].child];
    }
  };
  for (const [seatName, type] of def.steps) {
    foldTo(names.indexOf(seatName));
    const nd = node as DecisionNode;
    const a = nd.actions.findIndex((x) => x.type === type);
    if (a < 0) throw new Error(`${def.name}: ${seatName} has no ${type}`);
    path.push(a);
    node = tree.nodes[nd.actions[a].child];
  }
  foldTo(names.indexOf(def.at));
  return path;
}

/** frequency of each non-fold step on the path, over the acting player's range at that point */
function pathFrequencies(tree: GameTree, res: SolveResult, path: number[]): string[] {
  const names = seatNames(tree.numPlayers);
  const out: string[] = [];
  let node = tree.nodes[0] as DecisionNode;
  const steps: Array<[DecisionNode, number]> = [];
  for (const a of path) {
    if (node.actions[a].type !== 'fold') {
      const reach = new Float64Array(N).fill(1);
      for (const [nd, b] of steps) if (nd.player === node.player) for (let h = 0; h < N; h++) reach[h] *= res.strategy[res.offsets[nd.dIndex] + b * N + h];
      let num = 0, den = 0;
      for (let h = 0; h < N; h++) { const w = COMBOS[h] * reach[h]; den += w; num += w * res.strategy[res.offsets[node.dIndex] + a * N + h]; }
      out.push(`${names[node.player]} ${actionLabel(node.actions[a], node)} ${((num / den) * 100).toFixed(2)}%${num / den < 0.001 ? ' (희소 라인)' : ''}`);
    }
    steps.push([node, a]);
    node = tree.nodes[node.actions[a].child] as DecisionNode;
  }
  return out;
}

function playerReachAt(tree: GameTree, res: SolveResult, path: number[]): { node: DecisionNode; reach: Float64Array } {
  const reach = new Float64Array(N).fill(1);
  let node = tree.nodes[0] as DecisionNode;
  const steps: Array<[DecisionNode, number]> = [];
  for (const a of path) { steps.push([node, a]); node = tree.nodes[node.actions[a].child] as DecisionNode; }
  for (const [nd, a] of steps) {
    if (nd.player !== node.player) continue;
    const o = res.offsets[nd.dIndex] + a * N;
    for (let h = 0; h < N; h++) reach[h] *= res.strategy[o + h];
  }
  return { node, reach };
}

type Job = { config: SolverConfig; result: SolveResult; path: number[]; hands: number[]; samples: number; seed: number; foldedMode: FoldedMode };

if (!isMainThread) {
  const job = workerData as Job;
  const tree = buildTree(job.config);
  const out: HandReference[] = [];
  for (const h of job.hands) out.push(referenceHand(tree, job.result, job.path, h, job.samples, job.seed + h * 7919, job.foldedMode));
  parentPort!.postMessage(out);
} else {
  await main();
}

async function runReference(config: SolverConfig, result: SolveResult, path: number[], hands: number[], samples: number): Promise<HandReference[]> {
  const threads = Math.max(1, availableParallelism() - 2);
  const buckets: number[][] = Array.from({ length: threads }, () => []);
  hands.forEach((h, i) => buckets[i % threads].push(h));
  const parts = await Promise.all(
    buckets.filter((b) => b.length).map(
      (hs, i) =>
        new Promise<HandReference[]>((resolve, reject) => {
          const w = new Worker(new URL(import.meta.url), { workerData: { config, result, path, hands: hs, samples, seed: 1000 + i, foldedMode: FOLDED_MODE } });
          w.on('message', resolve);
          w.on('error', reject);
        }),
    ),
  );
  return parts.flat();
}

async function main() {
  const samples = arg('samples', 40000);
  const iterations = arg('iterations', 400);
  const onlyIdx = process.argv.indexOf('--only');
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1].split(',').map(Number) : null;
  const solves = new Map<string, { tree: GameTree; result: SolveResult; ms: number }>();
  const lines: string[] = [];
  const log = (s = '') => { console.log(s); lines.push(s); };

  log(`# 정확도 감사 리포트`);
  log();
  log(`솔버 반복 ${iterations}회, 핸드당 기준 샘플 ${samples.toLocaleString()}회 (실제 카드 딜링·전원 카드 제거·동률 사이드팟·ICM).`);
  log(`EV 오차 = |솔버 EV − 기준 EV|, 레인지 비중×빈도 가중 평균. 전략 손실 = 기준 EV로 본 최선 액션 대비 솔버 전략의 EV 손실.`);
  log(`유의한 실수 = 손실이 3×표준오차 이상이면서 ICM 0.02%p(Chip 0.05bb) 이상인 핸드.`);
  log();

  for (const [si, def] of SPOTS.entries()) {
    if (only && !only.includes(si + 1)) continue;
    const config = makeConfig(def, iterations);
    const key = JSON.stringify(config);
    if (!solves.has(key)) {
      const t0 = performance.now();
      const tree = buildTree(config);
      const solver = new Solver(tree);
      solver.run(iterations);
      solves.set(key, { tree, result: finalize(solver), ms: performance.now() - t0 });
    }
    const { tree, result, ms } = solves.get(key)!;
    const path = findPath(tree, def);
    const { node, reach } = playerReachAt(tree, result, path);
    const hands = Array.from({ length: N }, (_, h) => h).filter((h) => reach[h] > 0.02);
    const t1 = performance.now();
    const refs = await runReference(config, result, path, hands, samples);
    const unit = config.mode === 'icm' ? '%p' : 'bb';
    const primary = config.mode;
    const threshold = primary === 'icm' ? 0.02 : 0.05;

    const A = node.actions.length;
    const off = result.offsets[node.dIndex];
    let wSum = 0, errIcm = 0, errChip = 0, lossSum = 0, seSum = 0;
    let maxErr = { v: 0, label: '' };
    const mistakes: string[] = [];
    const rows: Array<{ h: number; loss: number; se: number; ref: HandReference }> = [];
    for (const ref of refs) {
      const h = ref.hand;
      const cw = COMBOS[h] * reach[h];
      let handLoss = -Infinity, lossSe = 0;
      for (let a = 0; a < A; a++) {
        const sig = result.strategy[off + a * N + h];
        const sIcm = result.evIcm[off + a * N + h];
        const sChip = result.evChip[off + a * N + h];
        const eI = Math.abs(sIcm - ref.evIcm[a]);
        const eC = Math.abs(sChip - ref.evChip[a]);
        if (Number.isFinite(eI) && Number.isFinite(eC)) {
          errIcm += cw * sig * eI;
          errChip += cw * sig * eC;
          wSum += cw * sig;
          const e = primary === 'icm' ? eI : eC;
          if (sig > 0.05 && e > maxErr.v) maxErr = { v: e, label: `${classLabel(h)} ${actionLabel(node.actions[a], node)}` };
        }
        const adv = primary === 'icm' ? ref.advIcm[a] : ref.advChip[a];
        const advSe = primary === 'icm' ? ref.advSeIcm[a] : ref.advSeChip[a];
        if (adv > handLoss) { handLoss = adv; lossSe = advSe; }
      }
      handLoss = Math.max(0, handLoss);
      lossSum += cw * handLoss;
      seSum += cw * lossSe;
      rows.push({ h, loss: handLoss, se: lossSe, ref });
      if (handLoss > 3 * lossSe && handLoss > threshold) mistakes.push(`${classLabel(h)} (${handLoss.toFixed(3)}±${lossSe.toFixed(3)})`);
    }
    const cwTotal = refs.reduce((s, r) => s + COMBOS[r.hand] * reach[r.hand], 0);

    log(`## ${si + 1}. ${def.name}`);
    log();
    log(`- 행동: ${seatNames(tree.numPlayers)[node.player]} · 액션 ${node.actions.map((a) => actionLabel(a, node)).join(' / ')} · 결정 노드 ${tree.numDecisions.toLocaleString()} · 솔브 ${(ms / 1000).toFixed(1)}초 · 기준 ${((performance.now() - t1) / 1000).toFixed(1)}초`);
    const freqs = pathFrequencies(tree, result, path);
    if (freqs.length) log(`- 경로 액션 빈도: ${freqs.join(' → ')}`);
    log(`- 감사 핸드 ${refs.length}개 (레인지 비중 2% 이상)`);
    log(`- EV 오차 평균: ICM ${(errIcm / wSum).toFixed(4)}%p · Chip ${(errChip / wSum).toFixed(3)}bb · 최대 ${maxErr.v.toFixed(3)}${unit} (${maxErr.label})`);
    log(`- 전략 손실 평균: ${(lossSum / cwTotal).toFixed(4)}${unit} (샘플 노이즈 수준 ${(seSum / cwTotal).toFixed(4)}${unit})`);
    log(`- 유의한 실수: ${mistakes.length ? mistakes.join(', ') : '없음'}`);
    log();
    log(`| 핸드 | 액션 | 빈도 | 솔버 EV | 기준 EV (±SE) |`);
    log(`|---|---|---|---|---|`);
    const showcase = ['AA', 'AKo', 'TT', 'A5s', 'KJo', '76s', '55', 'Q9o', '32o'];
    const pick = rows.filter((r) => showcase.includes(classLabel(r.h))).concat(rows.slice().sort((a, b) => b.loss - a.loss).slice(0, 3));
    const seen = new Set<number>();
    for (const r of pick) {
      if (seen.has(r.h)) continue;
      seen.add(r.h);
      for (let a = 0; a < A; a++) {
        const sig = result.strategy[off + a * N + r.h];
        const sEv = primary === 'icm' ? result.evIcm[off + a * N + r.h] : result.evChip[off + a * N + r.h];
        const rEv = primary === 'icm' ? r.ref.evIcm[a] : r.ref.evChip[a];
        const rSe = primary === 'icm' ? r.ref.seIcm[a] : r.ref.seChip[a];
        const d = primary === 'icm' ? 3 : 2;
        log(`| ${a === 0 ? classLabel(r.h) : ''} | ${actionLabel(node.actions[a], node)} | ${(sig * 100).toFixed(1)}% | ${sEv.toFixed(d)} | ${rEv.toFixed(d)} ±${rSe.toFixed(d)} |`);
      }
    }
    log();
  }

  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/accuracy-report.md', lines.join('\n') + '\n');
  console.log('wrote docs/accuracy-report.md');
}
