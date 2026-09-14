// Builds the pre-solved scenario pool served as static files (public/pool).
//
//   npm run build:pool -- [--budget-mb 70] [--threads 26] [--iterations 300] [--count N] [--clean]
//
// Each table is solved single-threaded in its own worker thread. Results are written as they finish and
// the manifest is rewritten after every table, so the script can be stopped and resumed at any time.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { Solver } from '../src/engine/solver';
import { buildTree } from '../src/engine/tree';
import { encodeStrategy } from '../src/engine/training/poolcodec';
import { PREBUILT_VERSION, type PrebuiltEntry, type PrebuiltManifest } from '../src/engine/training/prebuilt';
import { DEFAULT_TRAINING, mulberry32, randomScenario, type Scenario } from '../src/engine/training/scenario';

interface Job { scenario: Scenario }
interface Done { gz: Uint8Array; decisions: number; exploitability: number; iterations: number; ms: number }

/** stack ranges the pool covers; tables inside a narrow range also serve every wider range in the UI */
const BANDS = [
  { minStack: 10, maxStack: 45, weight: 4 },
  { minStack: 10, maxStack: 25, weight: 2 },
  { minStack: 20, maxStack: 60, weight: 2 },
  { minStack: 30, maxStack: 100, weight: 1 },
  { minStack: 60, maxStack: 200, weight: 1 },
];
const PLAYERS = [
  { players: 8, weight: 3 },
  { players: 7, weight: 1 },
  { players: 6, weight: 1 },
];

if (isMainThread) void main();
else {
  parentPort!.on('message', ({ scenario }: Job) => {
    const t0 = Date.now();
    const tree = buildTree(scenario.config);
    const solver = new Solver(tree);
    solver.run(scenario.config.iterations);
    // same post-processing as the in-browser solve: soften near-indifferent choices
    if ((scenario.config.smoothing ?? 0) > 0) solver.smooth(scenario.config.smoothing!);
    const exploitability = solver.exploitability();
    const gz = gzipSync(encodeStrategy(tree, solver.offsets, solver.averageStrategy()), { level: 9 });
    const msg: Done = { gz, decisions: tree.numDecisions, exploitability, iterations: solver.iterations, ms: Date.now() - t0 };
    parentPort!.postMessage(msg);
  });
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

/** smooth weighted round-robin: every item appears `weight` times per cycle, spread out */
function weightedCycle<T extends { weight: number }>(items: T[]): T[] {
  const out: T[] = [];
  const credit = items.map(() => 0);
  const total = items.reduce((a, b) => a + b.weight, 0);
  for (let k = 0; k < total; k++) {
    items.forEach((it, i) => (credit[i] += it.weight));
    const i = credit.indexOf(Math.max(...credit));
    credit[i] -= total;
    out.push(items[i]);
  }
  return out;
}

/**
 * Removes tables (in place) until the pool fits the budget, always from the group that is most over its
 * intended share (players × ICM/chip × stack depth), largest file first. Returns the removed entries.
 */
function prune(entries: PrebuiltEntry[], budget: number): PrebuiltEntry[] {
  const playerShare: Record<number, number> = { 8: 0.6, 7: 0.2, 6: 0.2 };
  const depthOf = (e: PrebuiltEntry) => {
    const max = Math.max(...e.scenario.config.stacks);
    return max <= 45 ? 'shallow' : max <= 100 ? 'mid' : 'deep';
  };
  const depthShare: Record<string, number> = { shallow: 0.6, mid: 0.3, deep: 0.1 };
  const keyOf = (e: PrebuiltEntry) => `${e.scenario.config.stacks.length}|${e.scenario.config.mode}|${depthOf(e)}`;
  const shareOf = (e: PrebuiltEntry) =>
    (playerShare[e.scenario.config.stacks.length] ?? 0.1) * (e.scenario.config.mode === 'chip' ? 0.15 : 0.85) * depthShare[depthOf(e)];
  const removed: PrebuiltEntry[] = [];
  let used = entries.reduce((a, e) => a + e.bytes, 0);
  while (used > budget && entries.length > 0) {
    const groups = new Map<string, PrebuiltEntry[]>();
    for (const e of entries) groups.set(keyOf(e), [...(groups.get(keyOf(e)) ?? []), e]);
    let worst: PrebuiltEntry[] = [];
    let worstRatio = -1;
    for (const g of groups.values()) {
      const ratio = g.length / (shareOf(g[0]) * entries.length);
      if (ratio > worstRatio) [worst, worstRatio] = [g, ratio];
    }
    const victim = worst.reduce((a, b) => (b.bytes > a.bytes ? b : a));
    entries.splice(entries.indexOf(victim), 1);
    used -= victim.bytes;
    removed.push(victim);
  }
  return removed;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const outDir = resolve('public/pool');
  const manifestPath = join(outDir, 'manifest.json');
  const budget = arg('budget-mb', 70) * 1e6;
  const threads = arg('threads', Math.max(1, cpus().length - 2));
  const iterations = arg('iterations', DEFAULT_TRAINING.iterations);
  const maxCount = arg('count', Infinity);

  if (process.argv.includes('--clean') && existsSync(outDir)) rmSync(outDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  let manifest: PrebuiltManifest = { version: PREBUILT_VERSION, createdAt: new Date().toISOString(), entries: [] };
  if (existsSync(manifestPath)) {
    const old = JSON.parse(readFileSync(manifestPath, 'utf8')) as PrebuiltManifest;
    if (old.version === PREBUILT_VERSION) manifest = old;
    else console.log(`manifest version ${old.version} is stale; rebuilding`);
  }
  // drop entries whose file went missing, and files no entry refers to
  manifest.entries = manifest.entries.filter((e) => existsSync(join(outDir, e.file)));
  const known = new Set(manifest.entries.map((e) => e.file));
  for (const f of readdirSync(outDir)) if (f.endsWith('.icp') && !known.has(f)) rmSync(join(outDir, f));

  const save = () => {
    manifest.createdAt = new Date().toISOString();
    writeFileSync(manifestPath + '.tmp', JSON.stringify(manifest));
    renameSync(manifestPath + '.tmp', manifestPath);
  };
  const pruned = prune(manifest.entries, budget);
  for (const e of pruned) rmSync(join(outDir, e.file));
  if (pruned.length > 0) console.log(`pruned ${pruned.length} tables to fit the budget`);
  save();

  const bands = weightedCycle(BANDS);
  const players = weightedCycle(PLAYERS);
  const rand = mulberry32((Date.now() ^ 0x5bd1e995) >>> 0);
  let cursor = manifest.entries.length;
  let used = manifest.entries.reduce((a, e) => a + e.bytes, 0);
  let inflightBytes = 0;
  let started = 0;
  let built = 0;
  const memLimit = freemem() * 0.7;
  let memUsed = 0;
  const t0 = Date.now();

  const nextJob = () => {
    const band = bands[cursor % bands.length];
    const pl = players[Math.floor(cursor / bands.length) % players.length];
    cursor++;
    const sc = randomScenario(rand, { ...DEFAULT_TRAINING, players: pl.players, minStack: band.minStack, maxStack: band.maxStack, iterations });
    const tree = buildTree(sc.config);
    let entries = 0;
    for (const nd of tree.nodes) if (nd.kind === 'decision') entries += nd.actions.length * 169;
    const id = createHash('sha1').update(JSON.stringify(sc.config)).digest('hex').slice(0, 16);
    const scenario: Scenario = { ...sc, id, createdAt: 0 };
    // 12-bit codes gzip to ~0.25 bytes per entry; solver state is ~16 bytes per entry plus the tree
    return { scenario, estBytes: entries * 0.3, estMem: entries * 48 + tree.nodes.length * 600 + 64e6 };
  };

  const self = fileURLToPath(import.meta.url);
  console.log(`building pool: budget ${(budget / 1e6).toFixed(0)}MB, ${threads} threads, ${iterations} iterations, existing ${manifest.entries.length} tables / ${(used / 1e6).toFixed(1)}MB`);

  await Promise.all(Array.from({ length: threads }, async () => {
    const worker = new Worker(self);
    try {
      while (started < maxCount) {
        const job = nextJob();
        // over budget: wait for running tables to report their real size, stop once nothing is running.
        // The check and the reservation below run without an await in between, so workers cannot overbook.
        for (;;) {
          while (memUsed > 0 && memUsed + job.estMem > memLimit) await sleep(500);
          if (used + inflightBytes + job.estBytes <= budget) break;
          if (inflightBytes === 0) break;
          await sleep(500);
        }
        if (used + inflightBytes + job.estBytes > budget) break;
        started++;
        inflightBytes += job.estBytes;
        memUsed += job.estMem;
        const done = await new Promise<Done>((res, rej) => {
          worker.once('message', res);
          worker.once('error', rej);
          worker.postMessage({ scenario: job.scenario } satisfies Job);
        });
        inflightBytes -= job.estBytes;
        memUsed -= job.estMem;
        const file = `${job.scenario.id}-${createHash('sha1').update(done.gz).digest('hex').slice(0, 8)}.icp`;
        writeFileSync(join(outDir, file), done.gz);
        const entry: PrebuiltEntry = {
          scenario: job.scenario,
          file,
          bytes: done.gz.byteLength,
          decisions: done.decisions,
          iterations: done.iterations,
          exploitability: done.exploitability,
        };
        manifest.entries.push(entry);
        used += entry.bytes;
        built++;
        save();
        const c = job.scenario.config;
        console.log(`[${manifest.entries.length}] ${job.scenario.label} · ${Math.min(...c.stacks)}-${Math.max(...c.stacks)}bb · ${done.decisions} decisions · ${(done.ms / 1000).toFixed(0)}s · expl ${done.exploitability.toFixed(3)} · ${(entry.bytes / 1e6).toFixed(2)}MB · total ${(used / 1e6).toFixed(1)}MB`);
      }
    } finally {
      await worker.terminate();
    }
  }));

  const size = readdirSync(outDir).reduce((a, f) => a + statSync(join(outDir, f)).size, 0);
  console.log(`done: ${built} new tables in ${((Date.now() - t0) / 60000).toFixed(1)} min; pool has ${manifest.entries.length} tables, ${(size / 1e6).toFixed(1)}MB`);
}
