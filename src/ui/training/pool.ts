// Scenario pool: tables ready for training, kept in IndexedDB.
//
// Tables come from the pre-built pool shipped as static files (public/pool, see scripts/build-pool.ts)
// whenever one fits the training settings; only when none is left the browser solves a random table itself.

import type { SolveResult } from '../../engine/solver';
import { isGzip } from '../../engine/training/poolcodec';
import { fitsMode, fitsSettings, PREBUILT_VERSION, type PrebuiltEntry, type PrebuiltManifest } from '../../engine/training/prebuilt';
import { randomScenario, mulberry32, type Scenario, type TrainingSettings } from '../../engine/training/scenario';
import { buildTree, type GameTree } from '../../engine/tree';
import type { SolvedScenario } from '../../engine/training/hand';
import type { FromHydrate, ToHydrate } from '../../worker/hydrate.worker';
import { solvePreflop, threadBudget } from './clients';

interface Packed {
  /** strategy file as downloaded (gzip or already decoded) */
  bytes: Uint8Array;
  exploitability: number;
  iterations: number;
}

interface StoredScenario {
  scenario: Scenario;
  /** locally solved tables keep the full result */
  result?: SolveResult;
  /** pre-built tables keep only the compact strategy; EVs are rebuilt when loaded */
  packed?: Packed;
  uses: number;
}

interface Item {
  stored: StoredScenario;
  result: SolveResult | null;
}

const DB_NAME = 'icm-preflop-lab';
const STORE = 'scenarios';
const MANIFEST_URL = 'pool/manifest.json';
const RETIRED_KEY = 'icm-preflop-lab.retired';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'scenario.id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface PoolStatus {
  ready: number;
  target: number;
  solving: { label: string; progress: number; kind: 'download' | 'solve' } | null;
  error: string | null;
}

export class ScenarioPool {
  private db: IDBDatabase | null = null;
  private memory: Item[] = [];
  private listeners = new Set<() => void>();
  private running = false;
  private stopped = false;
  private cancel: (() => void) | null = null;
  private treeCache = new Map<string, GameTree>();
  private manifest: Promise<PrebuiltEntry[]> | null = null;
  /** pre-built files that failed to download or decode this session */
  private broken = new Set<string>();
  status: PoolStatus;
  settings: TrainingSettings;
  /** return true while the pool should wait (e.g. a postflop solve is running) */
  isBusy: () => boolean = () => false;
  readonly maxUses = 25;

  constructor(settings: TrainingSettings, target: number) {
    this.settings = settings;
    this.status = { ready: 0, target, solving: null, error: null };
  }

  subscribe(cb: () => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(patch: Partial<PoolStatus> = {}) {
    this.status = { ...this.status, ...patch, ready: this.memory.filter((x) => x.result).length };
    for (const cb of this.listeners) cb();
  }

  private fits(sc: Scenario) {
    return fitsSettings(sc, this.settings) && fitsMode(sc, this.settings);
  }

  async load(): Promise<void> {
    try {
      this.db = await openDb();
      const all = await tx<StoredScenario[]>(this.db, 'readonly', (s) => s.getAll());
      this.memory = all
        .filter((x) => (x.result || x.packed) && this.fits(x.scenario))
        .map((stored) => ({ stored, result: stored.result ?? null }));
    } catch {
      this.db = null; // private mode or storage blocked: keep the pool in memory only
    }
    this.emit();
  }

  /** keep adding tables until the pool reaches its target size */
  async fill(): Promise<void> {
    if (this.running) {
      // a stop() may be pending (e.g. a remount): keep the running loop going
      this.stopped = false;
      return;
    }
    this.running = true;
    this.stopped = false;
    const rand = mulberry32((Date.now() ^ (Math.random() * 1e9)) >>> 0);
    try {
      while (!this.stopped) {
        while (this.isBusy() && !this.stopped) await sleep(400);
        if (this.stopped) break;
        const cold = this.memory.find((x) => !x.result);
        if (cold) {
          try {
            await this.warm(cold);
          } catch (err) {
            if (err instanceof Error && err.message === 'cancelled') {
              if (this.stopped) break;
            } else await this.drop(cold);
          }
          continue;
        }
        if (this.memory.length >= this.status.target) break;
        try {
          const entry = await this.pickPrebuilt(rand);
          if (entry) await this.download(entry);
          else await this.solveLocally(rand);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === 'cancelled') {
            if (this.stopped) break;
            continue;
          }
          this.emit({ error: message });
          break;
        }
      }
    } finally {
      this.running = false;
      this.cancel = null;
      this.emit({ solving: null });
    }
  }

  stop() {
    this.stopped = true;
    this.cancel?.();
  }

  private loadManifest(): Promise<PrebuiltEntry[]> {
    this.manifest ??= fetch(MANIFEST_URL, { cache: 'no-cache' })
      .then((r) => (r.ok ? (r.json() as Promise<PrebuiltManifest>) : null))
      .then((m) => (m && m.version === PREBUILT_VERSION && Array.isArray(m.entries) ? m.entries : []))
      .catch(() => []);
    return this.manifest;
  }

  /** a fitting pre-built table that is not in the pool, preferring ones not played recently */
  private async pickPrebuilt(rand: () => number): Promise<PrebuiltEntry | null> {
    if (typeof DecompressionStream === 'undefined') return null;
    const inPool = new Set(this.memory.map((x) => x.stored.scenario.id));
    let options = (await this.loadManifest()).filter((e) => this.fits(e.scenario) && !inPool.has(e.scenario.id) && !this.broken.has(e.file));
    if (options.length === 0) return null;
    const share = this.settings.chipEvShare;
    if (share > 0 && share < 1) {
      const want = rand() < share ? 'chip' : 'icm';
      const same = options.filter((e) => e.scenario.config.mode === want);
      if (same.length > 0) options = same;
    }
    const retired = readRetired();
    const oldest = Math.min(...options.map((e) => retired[e.scenario.id] ?? 0));
    const fresh = options.filter((e) => (retired[e.scenario.id] ?? 0) === oldest);
    return fresh[Math.floor(rand() * fresh.length)];
  }

  private async download(entry: PrebuiltEntry) {
    const label = entry.scenario.label;
    this.emit({ solving: { label, progress: 0, kind: 'download' }, error: null });
    const abort = new AbortController();
    this.cancel = () => abort.abort();
    let bytes: Uint8Array;
    try {
      bytes = await fetchBytes(new URL(entry.file, new URL(MANIFEST_URL, document.baseURI)).href, abort.signal, entry.bytes, (x) =>
        this.emit({ solving: { label, progress: x * 0.8, kind: 'download' } }));
    } catch (err) {
      if (abort.signal.aborted) throw new Error('cancelled');
      this.broken.add(entry.file);
      return;
    } finally {
      this.cancel = null;
    }
    const item: Item = {
      stored: { scenario: entry.scenario, packed: { bytes, exploitability: entry.exploitability, iterations: entry.iterations }, uses: 0 },
      result: null,
    };
    try {
      await this.warm(item, 0.8);
    } catch (err) {
      if (err instanceof Error && err.message === 'cancelled') throw err;
      this.broken.add(entry.file);
      return;
    }
    this.memory.push(item);
    this.emit();
    if (this.db) await tx(this.db, 'readwrite', (s) => s.put(item.stored)).catch(() => undefined);
  }

  /** rebuild EVs of a pre-built table */
  private async warm(item: Item, from = 0) {
    const packed = item.stored.packed;
    if (!packed) throw new Error('no data');
    this.emit({ solving: { label: item.stored.scenario.label, progress: from, kind: 'download' } });
    const raw = isGzip(packed.bytes) ? await gunzip(packed.bytes) : packed.bytes;
    const w = new Worker(new URL('../../worker/hydrate.worker.ts', import.meta.url), { type: 'module' });
    try {
      item.result = await new Promise<SolveResult>((resolve, reject) => {
        this.cancel = () => reject(new Error('cancelled'));
        w.onmessage = (e: MessageEvent<FromHydrate>) => (e.data.type === 'done' ? resolve(e.data.result) : reject(new Error(e.data.message)));
        w.onerror = (e) => reject(new Error(e.message || '테이블을 불러오지 못했습니다'));
        const msg: ToHydrate = { config: item.stored.scenario.config, bytes: raw, exploitability: packed.exploitability, iterations: packed.iterations };
        w.postMessage(msg);
      });
    } finally {
      w.terminate();
      this.cancel = null;
    }
    this.emit();
  }

  private async solveLocally(rand: () => number) {
    const scenario = randomScenario(rand, this.settings);
    this.emit({ solving: { label: scenario.label, progress: 0, kind: 'solve' }, error: null });
    // background solves use half the threads so hand solves stay responsive
    const job = solvePreflop(scenario.config, (x) => this.emit({ solving: { label: scenario.label, progress: x, kind: 'solve' } }), Math.max(1, Math.floor(threadBudget() / 2)));
    this.cancel = job.cancel;
    try {
      const result = await job.promise;
      const stored: StoredScenario = { scenario, result, uses: 0 };
      this.memory.push({ stored, result });
      this.emit();
      if (this.db) await tx(this.db, 'readwrite', (s) => s.put(stored)).catch(() => undefined);
    } finally {
      this.cancel = null;
    }
  }

  private async drop(item: Item) {
    this.memory = this.memory.filter((x) => x !== item);
    if (this.db) await tx(this.db, 'readwrite', (s) => s.delete(item.stored.scenario.id)).catch(() => undefined);
    this.emit();
  }

  /** take the least-used ready table; heavily used ones are retired and replaced */
  async take(): Promise<SolvedScenario | null> {
    const ready = this.memory.filter((x) => x.result);
    if (ready.length === 0) return null;
    const pick = ready.reduce((a, b) => (b.stored.uses < a.stored.uses ? b : a));
    const result = pick.result!;
    const { stored } = pick;
    stored.uses++;
    if (stored.uses >= this.maxUses) {
      if (stored.packed) writeRetired(stored.scenario.id);
      await this.drop(pick);
      void this.fill();
    } else if (this.db) {
      await tx(this.db, 'readwrite', (s) => s.put(stored)).catch(() => undefined);
    }
    this.emit();
    let tree = this.treeCache.get(stored.scenario.id);
    if (!tree) {
      tree = buildTree(stored.scenario.config);
      this.treeCache.clear();
      this.treeCache.set(stored.scenario.id, tree);
    }
    return { scenario: stored.scenario, tree, result };
  }

  async clear(): Promise<void> {
    this.stop();
    this.memory = [];
    if (this.db) await tx(this.db, 'readwrite', (s) => s.clear()).catch(() => undefined);
    this.emit();
  }

  async updateSettings(settings: TrainingSettings, target: number) {
    const changed = JSON.stringify(settings) !== JSON.stringify(this.settings);
    this.settings = settings;
    this.status = { ...this.status, target };
    if (changed) {
      this.stop();
      this.memory = this.memory.filter((x) => this.fits(x.stored.scenario));
    }
    this.emit();
  }
}

async function fetchBytes(url: string, signal: AbortSignal, expected: number, onProgress: (x: number) => void): Promise<Uint8Array> {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    onProgress(Math.min(1, got / Math.max(1, expected)));
  }
  const out = new Uint8Array(got);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.byteLength;
  }
  return out;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readRetired(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(RETIRED_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

function writeRetired(id: string) {
  try {
    const map = readRetired();
    map[id] = Date.now();
    localStorage.setItem(RETIRED_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
