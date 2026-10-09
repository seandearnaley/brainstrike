// The state store of one data root (ADR-0011): the run log plus the small authoritative tables in `<root>/state.db`,
// content-addressed blobs in `<root>/blobs/`, the root lock in `<root>/lock/`. Electron-free (ADR-0017): the data root
// is a constructor parameter.
//
// The write side is M0-A1's SqliteStore (src/store-sqlite.ts): this thread only posts messages to the writer worker
// (src/writer-worker.mjs), which holds the ONLY writing connection; an append is delivered (`onCommitted`) only after its
// COMMIT returned; a failed write or an unexpected worker exit fails the store, never a hang or a silent drop.
// The lifecycle is M0-A2's Host (src/host.ts) without the run host: synced-root refusal and the root lock at open, a
// damaged DB opened read-only and visibly, purge orchestration with a crash-replayable intent, export/import, reset.
// Every mutation runs on ONE write chain, so a purge's blob GC can never race an append that references the blob.
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep, win32 } from 'node:path';
import { Worker } from 'node:worker_threads';
import { IndexerRequiredError, ThreadDamagedError, ThreadReadOnlyError } from './errors.js';
import {
  type Decoded,
  decodeEvent,
  type EventSchema,
  type Mode,
  type Unreadable,
} from './event-schema.js';
import { RootLock } from './lock.js';
import type { McpTaskDomainReply, McpTaskDomainRequest } from './mcp-task-types.js';
import type { MemoryDomainPort, MemoryDomainRequest, MemorySnapshot } from './memory-types.js';
import { blobsOf, TOMBSTONE_BODY, withSeq } from './run-log-format.mjs';
import type { AppendItem, BlobContent, LogRow, RunEvent, ThreadStatus } from './run-log-types.js';
import { openRo, vacuumInto } from './sqlite.js';
import { readAll, SqliteReader } from './sqlite-reader.js';
import type {
  ExportedThread,
  HydrationThread,
  IndexerPort,
  Manifest,
  PurgeReport,
  StateStoreOptions,
  StoreSettings,
  SyncSpan,
} from './state-store-types.js';
import { assertNotSyncedRoot } from './sync-roots.js';
import { errorOf, logRowOf, type WorkerRow } from './worker-reply.js';

export const STATE_DB = 'state.db';
export const BLOBS_DIR = 'blobs';
/** Every entry the store creates in its data root besides the lock directory, which the lock removes itself. */
export const STORE_ENTRIES: readonly string[] = [
  STATE_DB,
  `${STATE_DB}-wal`,
  `${STATE_DB}-shm`,
  BLOBS_DIR,
];

/** Text of this size or more is stored as a content-addressed blob; the event keeps a preview and the hash. */
export type {
  CheckpointRow,
  ExportedThread,
  HydrationThread,
  IndexerPort,
  Manifest,
  PurgeReport,
  StateStoreHooks,
  StateStoreOptions,
  StoreSettings,
  SyncSpan,
  WriteSpan,
} from './state-store-types.js';

export const BLOB_MIN_BYTES = 12 * 1024;
export const PREVIEW_CHARS = 2048;

export const sha256Hex = (b: Buffer | string): string =>
  createHash('sha256').update(b).digest('hex');

export type StoredText =
  | { readonly output: string }
  | { readonly preview: string; readonly blob: string; readonly bytes: number };

/**
 * M0-A2 Host.toBody's rule for a large text: the fields to put in the event and, at 12 KB or more, the blob to append
 * with it (`AppendItem.blobs`), so the blob is durable before the event that references it commits.
 */
export function largeText(output: string): {
  readonly fields: StoredText;
  readonly blob: BlobContent | null;
} {
  const bytes = Buffer.byteLength(output);
  if (bytes < BLOB_MIN_BYTES) {
    return { blob: null, fields: { output } };
  }
  const hash = sha256Hex(output);
  return {
    blob: { content: output, hash },
    fields: { blob: hash, bytes, preview: output.slice(0, PREVIEW_CHARS) },
  };
}

/** Trusted host composition after writer readiness, before interrupted purge replay. */
export interface StateStoreStartupOwner {
  acquire(store: StateStore): Promise<IndexerPort | undefined>;
  /** Failed startup joins external resources before the canonical writer or Root can close. */
  close(): Promise<void>;
}

/** Failed startup retains the original writer and Root when external cleanup is unproved. */
export class StateStoreStartupError extends AggregateError {
  constructor(
    causes: readonly unknown[],
    readonly store: StateStore
  ) {
    super(causes, 'State startup cleanup failed; durable root ownership is retained');
  }
}

type Reply = Readonly<Record<string, unknown>> & {
  readonly id: number;
  readonly error?: string;
  readonly errorKind?: 'readonly' | 'damaged' | 'checkpoint-blocked' | 'failed';
};

interface Waiter {
  readonly reject: (e: Error) => void;
  readonly resolve: (r: Reply) => void;
}

interface Ready {
  readonly damage: string | null;
  readonly ready: true;
  readonly settings: StoreSettings;
}

const runIdOf = (e: RunEvent): string | null =>
  typeof e['runId'] === 'string' ? e['runId'] : null;

function waitReady(worker: Worker): Promise<Ready> {
  return new Promise((resolve, reject) => {
    const onMessage = (m: Partial<Ready>): void => {
      if (m.ready === true) {
        cleanup();
        resolve(m as Ready);
      }
    };
    const onError = (e: Error): void => {
      cleanup();
      reject(e);
    };
    const onExit = (code: number): void => {
      cleanup();
      reject(new Error(`StateStore writer worker exited during open (code ${code})`));
    };
    const cleanup = (): void => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
  });
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => {
      const p = join(dir, d.name);
      return d.isDirectory() ? listFiles(p, base) : [relative(base, p).split('\\').join('/')];
    })
    .sort();
}

/** Portable bundle paths cannot escape either the source or the destination root. */
function assertBundleRelativePath(path: unknown): asserts path is string {
  if (
    typeof path !== 'string' ||
    path.includes('\0') ||
    path.includes('\\') ||
    isAbsolute(path) ||
    win32.parse(path).root ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new TypeError('import: manifest file paths must be canonical relative paths');
  }
}
function checkedBundleSource(bundleRoot: string, path: string): string {
  const source = realpathSync(join(bundleRoot, path));
  const fromRoot = relative(bundleRoot, source);
  if (isAbsolute(fromRoot) || fromRoot.split(sep)[0] === '..') {
    throw new TypeError('import: bundle source escapes its root');
  }
  return source;
}

const GENERATION_FILE = /^g[0-9]{12}$/;

/** Per-thread watermarks (max seq) of an exported state DB. */
function watermarksOf(statePath: string): ExportedThread[] {
  const b = openRo(statePath);
  try {
    return b
      .prepare(
        'SELECT thread_id AS threadId, max(seq) AS watermark FROM run_events GROUP BY thread_id ORDER BY thread_id'
      )
      .all() as ExportedThread[];
  } finally {
    b.close();
  }
}

/** Every blob hash the verified events of a root (or bundle) reference. */
function blobsReferencedBy(root: string): Set<string> {
  const reader = new SqliteReader(root);
  const hashes = new Set<string>();
  try {
    for (const t of reader.threads()) {
      for (const it of readAll(reader, t)) {
        for (const h of it.kind === 'event' ? blobsOf(it.raw) : []) {
          hashes.add(h);
        }
      }
    }
  } finally {
    reader.close();
  }
  return hashes;
}

export class StateStore implements MemoryDomainPort {
  readonly root: string;
  readonly lock: RootLock;
  readonly settings: StoreSettings;
  /** The integrity_check failure if the state DB opened damaged (read-only); null when healthy. */
  readonly stateDamage: string | null;
  private readonly statePath: string;
  private readonly blobsPath: string;
  private readonly worker: Worker;
  private readonly options: StateStoreOptions;
  private indexer: IndexerPort | undefined;
  private readonly waiters = new Map<number, Waiter>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly deferredGc = new Set<string>();
  private readonly visible = new Map<string, Unreadable>();
  private chain: Promise<unknown> = Promise.resolve();
  private nextId = 0;
  private closed = false;
  private closeTask: Promise<void> | undefined;
  private closing = false;
  private failed: unknown = null;
  /** Exports in flight plus holdBlobGc holders: while any holds, unreferenced blobs wait in deferredGc. */
  private gcHolds = 0;

  private constructor(
    root: string,
    lock: RootLock,
    worker: Worker,
    ready: Ready,
    options: StateStoreOptions
  ) {
    this.root = root;
    this.lock = lock;
    this.worker = worker;
    this.settings = ready.settings;
    this.stateDamage = ready.damage;
    this.options = options;
    this.indexer = options.indexer;
    this.statePath = join(root, STATE_DB);
    this.blobsPath = join(root, BLOBS_DIR);
    worker.on('message', (m: Reply) => {
      const w = this.waiters.get(m.id);
      if (!w) {
        return;
      }
      this.waiters.delete(m.id);
      if (m.errorKind) {
        w.reject(errorOf(m));
      } else {
        w.resolve(m);
      }
    });
    worker.on('error', (e) => this.fail(e));
    // An exit we did not ask for (crash, terminate) fails every pending and later call: never a hang, never a silent drop.
    worker.on('exit', (code) => {
      if (!this.closing) {
        this.fail(new Error(`StateStore writer worker exited (code ${code})`));
      }
    });
  }

  static async open(dataRoot: string, options: StateStoreOptions = {}): Promise<StateStore> {
    // Refused before anything is created (M0-A2 item 6).
    assertNotSyncedRoot(dataRoot, options.home === undefined ? {} : { home: options.home });
    mkdirSync(dataRoot, { recursive: true });
    const lock = await RootLock.acquire(dataRoot, options);
    let worker: Worker | null = null;
    let store: StateStore | undefined;
    try {
      mkdirSync(join(dataRoot, BLOBS_DIR), { recursive: true });
      worker = new Worker(new URL('./writer-worker.mjs', import.meta.url), {
        workerData: {
          blobsDir: join(dataRoot, BLOBS_DIR),
          busyTimeoutMs: options.busyTimeoutMs ?? 5000,
          checkpointPages: options.checkpointPages ?? 1000,
          crashTestHooks: options.crashTestHooks,
          fullfsync: options.fullfsync ?? process.platform === 'darwin',
          memoryCalculatorModule: options.memoryCalculatorModule,
          path: join(dataRoot, STATE_DB),
          walCheckpoint: options.walCheckpoint ?? 'boundary',
        },
      });
      const ready = await waitReady(worker);
      store = new StateStore(dataRoot, lock, worker, ready, options);
      if (options.startup) {
        await store.acquireStartupIndexer();
      }
      if (ready.damage === null) {
        const acquired = store;
        await acquired.run(() => acquired.replayPurgeIntents());
      }
      return store;
    } catch (e) {
      if (store && options.startup) {
        try {
          await options.startup.close();
        } catch (cleanup) {
          throw new StateStoreStartupError([e, cleanup], store);
        }
      }
      if (worker) {
        await worker.terminate(); // better-sqlite3 closes the connection when the worker is torn down
      }
      if (!lock.isReleased) {
        lock.release();
      }
      throw e;
    }
  }

  private async acquireStartupIndexer(): Promise<void> {
    const indexer = await this.options.startup?.acquire(this);
    if (indexer) {
      this.indexer = indexer;
    }
  }

  private fail(e: unknown): void {
    this.failed ??= e;
    for (const w of this.waiters.values()) {
      w.reject(e instanceof Error ? e : new Error(String(e)));
    }
    this.waiters.clear();
  }

  private call(msg: Readonly<Record<string, unknown>>): Promise<Reply> {
    if (this.failed) {
      return Promise.reject(
        new Error(`StateStore failed earlier: ${String(this.failed)}`, { cause: this.failed })
      );
    }
    if (this.closing || this.worker.threadId === -1) {
      return Promise.reject(new Error('StateStore is closed'));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { reject, resolve });
      this.worker.postMessage({ ...msg, id });
    });
  }

  /** The write chain: every mutation of the run log, blobs and settings runs here, one at a time (M0-A2 Host.run). */
  private run<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('StateStore is closed'));
    }
    const p = this.chain.then(fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private requireIndexer(operation: string): IndexerPort {
    const { indexer } = this;
    if (!indexer) {
      throw new IndexerRequiredError(operation);
    }
    return indexer;
  }

  // ---- run log --------------------------------------------------------------------------------------------------------

  /**
   * Append rows (possibly across threads) as ONE NORMAL commit. `onCommitted` runs right after the COMMIT returned and
   * before the next write starts: the process-crash contract. `full` makes the rows and existing run_sync marker
   * one FULL transaction, so terminal success is never committed ahead of its kernel sync.
   * A write failure fails the store (later calls are refused,
   * so no seq is ever reused); a damaged thread refuses the batch without failing the store.
   */
  append(
    items: readonly AppendItem[],
    onCommitted?: () => void,
    durability: 'normal' | 'full' = 'normal'
  ): Promise<LogRow[]> {
    if (this.closed) {
      return Promise.reject(new Error('StateStore is closed'));
    }
    const bodies = items.map((it) => JSON.stringify(it.event));
    const rows = items.map((it, i) => [
      it.threadId,
      it.event.type,
      runIdOf(it.event),
      bodies[i],
      it.rawCount ?? null,
      it.hydrate === false ? 0 : 1,
    ]);
    return this.run(async () => {
      for (const it of items) {
        for (const b of it.blobs ?? []) {
          await this.call({ content: b.content, hash: b.hash, op: 'putBlob' });
        }
      }
      return this.call({ boundary: durability === 'full', op: 'append', rows }).then(
        (r) => {
          this.options.onWriteSpan?.({ t0: Number(r['t0']), t1: Number(r['t1']) });
          if (durability === 'full') {
            for (const threadId of new Set(items.map((item) => item.threadId))) {
              this.options.onSyncSpan?.({
                checkpoint: null,
                kind: 'FULL commit',
                t0: Number(r['t0']),
                t1: Number(r['t1']),
                thread: threadId,
              });
            }
          }
          onCommitted?.();
          const seqs = r['seqs'] as number[];
          return items.map((it, i): LogRow => {
            const raw = withSeq(seqs[i] as number, bodies[i] as string);
            const row = {
              event: JSON.parse(raw) as RunEvent,
              raw,
              seq: seqs[i] as number,
              threadId: it.threadId,
              ts: Number(r['ts']),
            };
            return it.rawCount === undefined ? row : { ...row, rawCount: it.rawCount };
          });
        },
        (e: unknown) => {
          if (!(e instanceof ThreadReadOnlyError)) {
            this.failed ??= e;
          }
          throw e;
        }
      );
    });
  }

  /** OS-crash contract: one real kernel sync covering everything already committed (the step-boundary op). */
  syncBoundary(threadId: string): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('StateStore is closed'));
    }
    const p = this.run(() => this.call({ op: 'boundary', threadId })).then((r) => {
      const checkpoint = (r['checkpoint'] ?? null) as SyncSpan['checkpoint'];
      this.options.onSyncSpan?.({
        checkpoint,
        kind: checkpoint ? 'checkpoint(PASSIVE)+FULL commit' : 'FULL commit',
        t0: Number(r['t0']),
        t1: Number(r['t1']),
        thread: threadId,
      });
    });
    this.inflight.add(p);
    const done = (): void => {
      this.inflight.delete(p);
    };
    p.then(done, done);
    return p;
  }

  /** Verified rows from `fromSeq` (all of them unless `limit`). Rejects with ThreadDamagedError on reaching damage. */
  async read(threadId: string, fromSeq = 1, limit = 0): Promise<LogRow[]> {
    const r = await this.call({
      fromSeq,
      limit: limit > 0 ? limit : Number.MAX_SAFE_INTEGER,
      op: 'read',
      threadId,
    });
    if (r['damage']) {
      throw errorOf(r['damage'] as Readonly<Record<string, unknown>>);
    }
    return (r['rows'] as WorkerRow[]).map((x) => logRowOf(threadId, x));
  }

  /**
   * Every thread with its catalog times and the rows a hydrating reader folds, in one writer round trip: the verified
   * rows not appended with `hydrate: false`, up to the thread's damage, which is returned rather than thrown so one
   * damaged thread never fails the read.
   */
  async readHydration(): Promise<HydrationThread[]> {
    const threads = (await this.call({ op: 'readHydration' }))['threads'] as Array<{
      createdAt: number;
      damage: Readonly<Record<string, unknown>> | null;
      rows: WorkerRow[];
      threadId: string;
      updatedAt: number;
    }>;
    return threads.map(({ createdAt, damage, rows, threadId, updatedAt }) => {
      const thread = {
        createdAt,
        rows: rows.map((x) => logRowOf(threadId, x)),
        threadId,
        updatedAt,
      };
      if (!damage) {
        return thread;
      }
      const error = errorOf(damage);
      if (!(error instanceof ThreadDamagedError)) {
        throw error;
      }
      return { ...thread, damage: error };
    });
  }

  /** One verified writer-side snapshot, for shared-resource transcript projection. */
  async readAll(): Promise<LogRow[]> {
    const reply = await this.call({ op: 'readAll' });
    const rows = reply['rows'] as Array<{
      seq: number;
      payload: string;
      rawCount: number | null;
      threadId: string;
      ts: number;
    }>;
    return rows.map((row) => ({
      event: JSON.parse(row.payload) as RunEvent,
      raw: row.payload,
      seq: row.seq,
      threadId: row.threadId,
      ts: row.ts,
      ...(row.rawCount === null ? {} : { rawCount: row.rawCount }),
    }));
  }

  /**
   * Upgraded events (M0-A2 Host.read). An event the schema cannot interpret throws in dev mode; in prod it is returned
   * in place as `unreadable` and listed in `health().visibleErrors`.
   */
  async readEvents<E>(
    threadId: string,
    schema: EventSchema<E>,
    mode: Mode,
    fromSeq = 1
  ): Promise<Decoded<E>[]> {
    const out: Decoded<E>[] = [];
    for (const r of await this.read(threadId, fromSeq)) {
      const d = decodeEvent(r.raw, mode, schema);
      if ((d as { type?: unknown }).type === 'unreadable') {
        this.visible.set(`${threadId}\u0000${r.seq}`, d as Unreadable);
      }
      out.push(d);
    }
    return out;
  }

  async status(threadId: string): Promise<ThreadStatus> {
    return (await this.call({ op: 'status', threadId }))['status'] as ThreadStatus;
  }

  async threads(): Promise<string[]> {
    return (await this.call({ op: 'threads' }))['threads'] as string[];
  }

  /**
   * Defers blob unlinking until the returned release runs (each release counts once). A reader that holds threads it
   * could not fold, whose blob references no count sees, holds collection while they exist.
   */
  holdBlobGc(): () => Promise<void> {
    this.gcHolds++;
    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      await this.releaseGcHold();
    };
  }

  private async releaseGcHold(): Promise<void> {
    this.gcHolds--;
    if (this.gcHolds === 0 && this.deferredGc.size > 0) {
      const pending = [...this.deferredGc];
      this.deferredGc.clear();
      const indexer = this.requireIndexer('blob GC');
      await this.run(() => this.gc(indexer, pending));
    }
  }

  /** Threads whose every row verified (purge GC and catch-up read only these). */
  private async okThreads(): Promise<string[]> {
    return (await this.call({ op: 'okThreads' }))['threads'] as string[];
  }

  /** `PRAGMA integrity_check` plus per-thread seq contiguity (the reopen check after a crash). */
  async check(): Promise<{ integrity: string; gaps: number }> {
    const r = await this.call({ op: 'check' });
    return { gaps: Number(r['gaps']), integrity: String(r['integrity']) };
  }

  setSetting(key: string, value: string): Promise<void> {
    return this.run(async () => {
      await this.call({ key, op: 'setting', value });
    });
  }

  /** One app setting's value, or undefined when it is unset. */
  async getSetting(key: string): Promise<string | undefined> {
    const value = (await this.call({ key, op: 'getSetting' }))['value'];
    return typeof value === 'string' ? value : undefined;
  }

  /** Removes one app setting; true when it existed. */
  deleteSetting(key: string): Promise<boolean> {
    return this.run(
      async () => (await this.call({ key, op: 'deleteSetting' }))['deleted'] === true
    );
  }

  /** Native metadata/WM/OM use this same writer and mutation chain; transcript stays in the log. */
  memory(request: MemoryDomainRequest): Promise<MemorySnapshot> {
    const execute = async (): Promise<MemorySnapshot> => {
      const reply = await this.call({ op: 'memory', request });
      return reply['snapshot'] as MemorySnapshot;
    };
    return request.operation === 'read' ? execute() : this.run(execute);
  }

  /** MCP Tasks handles on this same writer: reads run directly, writes join the mutation chain. */
  mcpTasks(request: McpTaskDomainRequest): Promise<McpTaskDomainReply> {
    const execute = async (): Promise<McpTaskDomainReply> => {
      const reply = await this.call({ op: 'mcp-tasks', request });
      return { rows: reply['rows'] as McpTaskDomainReply['rows'] };
    };
    return request.operation === 'get' || request.operation === 'list-active'
      ? execute()
      : this.run(execute);
  }

  health(): { stateDamage: string | null; visibleErrors: Unreadable[] } {
    return { stateDamage: this.stateDamage, visibleErrors: [...this.visible.values()] };
  }

  // ---- purge ----------------------------------------------------------------------------------------------------------

  /**
   * Purge event `seq`: when this resolves no byte of it is left in the state DB files, the derived store or the blobs
   * (M0-A2 item 1). An intent is recorded first, so a crash at any point is completed by the next open.
   */
  async purge(threadId: string, seq: number): Promise<PurgeReport> {
    const indexer = this.requireIndexer('purge');
    return this.run(async () => {
      const [ev] = await this.read(threadId, seq, 1);
      if (!ev || ev.seq !== seq) {
        throw new Error(`purge: ${threadId}#${seq} does not exist`);
      }
      const r = await this.call({
        hashes: JSON.stringify(blobsOf(ev.raw)),
        op: 'intentRecord',
        seq,
        threadId,
      });
      return this.completePurge(
        indexer,
        threadId,
        seq,
        JSON.parse(String(r['hashes'])) as string[]
      );
    });
  }

  /** Idempotent: also replays an intent left by a crash at any point. */
  private async completePurge(
    indexer: IndexerPort,
    threadId: string,
    seq: number,
    hashes: readonly string[]
  ): Promise<PurgeReport> {
    const t0 = performance.now();
    await this.call({ op: 'purge', seq, threadId, tombstone: withSeq(seq, TOMBSTONE_BODY) });
    const t1 = performance.now();
    this.options.hooks?.purgeAfterTruth?.();
    await indexer.reindex(threadId, seq);
    const t2 = performance.now();
    const deleted = await this.gc(indexer, hashes);
    await this.call({ op: 'intentDelete', seq, threadId });
    const t3 = performance.now();
    return {
      blobsDeleted: deleted,
      derivedMs: t2 - t1,
      gcMs: t3 - t2,
      ms: t3 - t0,
      truthMs: t1 - t0,
    };
  }

  private async replayPurgeIntents(): Promise<void> {
    const intents = (await this.call({ op: 'intentList' }))['intents'] as Array<{
      threadId: string;
      seq: number;
      hashes: string;
      operation: 'event' | 'thread';
    }>;
    if (intents.length === 0) {
      return;
    }
    const indexer = this.requireIndexer('completing an interrupted purge');
    for (const i of intents) {
      if (i.operation === 'thread') {
        await this.completeThreadDelete(indexer, i.threadId, JSON.parse(i.hashes) as string[]);
      } else {
        await this.completePurge(indexer, i.threadId, i.seq, JSON.parse(i.hashes) as string[]);
      }
    }
  }

  /** Unlink blobs no event references any more. Runs in the chain after the indexer caught up with every thread. */
  private async gc(indexer: IndexerPort, hashes: readonly string[]): Promise<string[]> {
    if (hashes.length === 0) {
      return [];
    }
    // Held: the counts are taken at release. A holder may hold threads the indexer cannot yet read.
    if (this.gcHolds > 0) {
      for (const h of hashes) {
        this.deferredGc.add(h);
      }
      return [];
    }
    const counts = await indexer.gcCheck(await this.okThreads(), hashes);
    // A damaged thread is outside the verified count, yet its rows still name blobs (RunLog.damagedBlobRefs).
    const held = new Set((await this.call({ op: 'damagedBlobRefs' }))['hashes'] as string[]);
    const unlink: string[] = [];
    for (const h of hashes) {
      const count = counts[h];
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
        throw new Error(`indexer returned an invalid reference count for blob ${h}`);
      }
      if (count === 0 && !held.has(h)) {
        unlink.push(h);
      }
    }
    if (unlink.length === 0) {
      return [];
    }
    return (await this.call({ hashes: unlink, op: 'unlinkBlobs' }))['deleted'] as string[];
  }

  async deleteThread(threadId: string): Promise<string[]> {
    const indexer = this.requireIndexer('thread delete');
    return this.run(async () => {
      // A held collection counts at release, so nothing needs the indexer current now.
      if (this.gcHolds === 0) {
        await indexer.catchUp(await this.okThreads());
      }
      // Stored references, verified or not: a thread whose rows failed verification still deletes.
      const hashes = (await this.call({ op: 'storedBlobRefs', threadId }))['hashes'] as string[];
      const intent = await this.call({
        hashes: JSON.stringify(hashes),
        op: 'intentRecord',
        operation: 'thread',
        seq: 0,
        threadId,
      });
      return this.completeThreadDelete(
        indexer,
        threadId,
        JSON.parse(String(intent['hashes'])) as string[]
      );
    });
  }

  private async completeThreadDelete(
    indexer: IndexerPort,
    threadId: string,
    hashes: readonly string[]
  ): Promise<string[]> {
    await this.call({ op: 'deleteThread', threadId });
    const references = await indexer.dropThread(threadId);
    const deleted = await this.gc(indexer, [...new Set([...hashes, ...references])]);
    await this.call({ op: 'intentDelete', seq: 0, threadId });
    return deleted;
  }

  // ---- export / import ------------------------------------------------------------------------------------------------

  /**
   * A consistent bundle of the root while it keeps streaming: the state DB through `VACUUM INTO` on a worker, every
   * blob the snapshot references, the root's lock files, and a manifest of sizes and sha256s. Blob GC is deferred
   * until the export ends, so a purge racing it cannot remove a blob the bundle still needs.
   */
  async exportTo(bundleDir: string): Promise<Manifest> {
    if (existsSync(bundleDir)) {
      throw new Error(`export: ${bundleDir} already exists`);
    }
    mkdirSync(bundleDir, { recursive: true });
    this.gcHolds++;
    try {
      await this.run(() => undefined); // the snapshot is not older than any write issued before this call
      await this.options.hooks?.exportAfterSnapshot?.();
      const dest = join(bundleDir, STATE_DB);
      await vacuumInto(this.statePath, dest);
      const threads = watermarksOf(dest);
      await this.options.hooks?.exportBeforeBlobs?.();
      mkdirSync(join(bundleDir, BLOBS_DIR), { recursive: true });
      for (const h of blobsReferencedBy(bundleDir)) {
        const src = join(this.blobsPath, h);
        if (!existsSync(src)) {
          throw new Error(`export: blob ${h} referenced by the snapshot is missing`);
        }
        copyFileSync(src, join(bundleDir, BLOBS_DIR, h));
      }
      // A root-shaped copy carries the root's lock, exactly as a file-level backup would.
      mkdirSync(join(bundleDir, 'lock'), { recursive: true });
      for (const n of readdirSync(this.lock.dir).filter((x) => GENERATION_FILE.test(x))) {
        copyFileSync(join(this.lock.dir, n), join(bundleDir, 'lock', n));
      }
      const files = listFiles(bundleDir)
        .filter((p) => !p.startsWith('lock/'))
        .map((p) => {
          const buf = readFileSync(join(bundleDir, p));
          return { bytes: buf.length, path: p, sha256: sha256Hex(buf) };
        });
      const m: Manifest = { files, format: 1, sourceHost: this.lock.owner.host, threads };
      writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(m, null, 1));
      return m;
    } finally {
      await this.releaseGcHold();
    }
  }

  /** Export the run log and its referenced blob bytes as versioned, checksummed JSONL on the worker. */
  exportJsonl(path: string): Promise<void> {
    return this.run(async () => {
      await this.call({ op: 'exportJsonl', path });
    });
  }

  /** Import validated JSONL into an empty run log. Complete state records use importBundle instead. */
  importJsonl(path: string): Promise<void> {
    return this.run(async () => {
      await this.call({ op: 'importJsonl', path });
    });
  }

  /** Restore a bundle into an empty (or new) root. Verifies every file; open the root afterwards with StateStore.open. */
  static importBundle(bundleDir: string, targetRoot: string): Manifest {
    const bundleRoot = realpathSync(bundleDir);
    const m = JSON.parse(
      readFileSync(checkedBundleSource(bundleRoot, 'manifest.json'), 'utf8')
    ) as Manifest;
    if (m.format !== 1) {
      throw new Error(`import: unknown bundle format ${String(m.format)}`);
    }
    // Validate the entire manifest before any payload read or destination mutation.
    for (const file of m.files) {
      assertBundleRelativePath(file.path);
    }
    const lockFiles = existsSync(join(bundleRoot, 'lock'))
      ? readdirSync(checkedBundleSource(bundleRoot, 'lock')).map((name) => `lock/${name}`)
      : [];
    for (const path of lockFiles) {
      assertBundleRelativePath(path);
    }
    for (const path of [...m.files.map((file) => file.path), ...lockFiles]) {
      checkedBundleSource(bundleRoot, path);
    }
    if (existsSync(targetRoot) && readdirSync(targetRoot).length > 0) {
      throw new Error(`import: ${targetRoot} is not empty`);
    }
    for (const f of m.files) {
      const b = readFileSync(checkedBundleSource(bundleRoot, f.path));
      if (b.length !== f.bytes || sha256Hex(b) !== f.sha256) {
        throw new Error(`import: ${f.path} does not match the manifest`);
      }
    }
    const copy = (rel: string): void => {
      const source = checkedBundleSource(bundleRoot, rel);
      const dst = join(targetRoot, rel);
      mkdirSync(join(dst, '..'), { recursive: true });
      copyFileSync(source, dst);
      const fd = openSync(dst, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    };
    for (const f of m.files) {
      if (f.path !== 'manifest.json') {
        copy(f.path);
      }
    }
    for (const path of lockFiles) {
      copy(path);
    }
    return m;
  }

  // ---- reset / close --------------------------------------------------------------------------------------------------

  private async shutdownWriter(): Promise<void> {
    const database = await Promise.allSettled([this.call({ op: 'close' })]);
    this.closing = true;
    // better-sqlite3 closes every connection on the worker's environment teardown.
    // Preserve a database rejection even when physical termination also rejects.
    const writer = await Promise.allSettled([this.worker.terminate()]);
    const failures = [...database, ...writer]
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'StateStore database and writer cleanup failed');
    }
  }

  /**
   * Factory reset: every handle closed (this store and the indexer), every store file removed, the lock released and
   * its directory removed. Entries of the root the store did not create are left alone.
   */
  reset(): Promise<void> {
    return this.run(async () => {
      await this.indexer?.reset();
      await this.shutdownWriter();
      for (const n of STORE_ENTRIES) {
        rmSync(join(this.root, n), { force: true, recursive: true });
      }
      this.lock.releaseAndRemove();
      this.closed = true;
    });
  }

  /** Waits for queued writes and in-flight boundary syncs, then releases the files and the lock. */
  close(): Promise<void> {
    this.closeTask ??= this.closed ? Promise.resolve() : this.closeOwned();
    return this.closeTask;
  }

  private async closeOwned(): Promise<void> {
    this.closed = true;
    await this.chain;
    while (this.inflight.size) {
      await Promise.allSettled([...this.inflight]);
    }
    // BST-1977: a failed physical join cannot authorize Root release, and every
    // caller retains the original close promise rather than an early success.
    // https://github.com/seandearnaley/brainstrike/pull/3543#issuecomment-6053571110
    await this.shutdownWriter();
    this.lock.release();
  }
}
