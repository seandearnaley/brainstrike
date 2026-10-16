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
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  ForgePrCacheEntry,
  ThreadGroupsReply,
  ThreadGroupsRequest,
  ViewFilterPresetReply,
  ViewFilterPresetRequest,
} from '@brainstrike/types';
import type { PromptLibraryReply, PromptLibraryRequest } from '@brainstrike/types/prompt-item';
import type { CollectionReply, CollectionRequest } from './collection-types.js';
import { ThreadDamagedError, ThreadReadOnlyError } from './errors.js';
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
import type {
  ModelChoiceRequest,
  ModelChoiceResult,
  ModelChoiceSnapshot,
} from './model-choice-types.js';
import type { PromptCatalogReply, PromptCatalogRequest } from './prompt-catalog-types.js';
import { executePromptLibrary } from './prompt-library.js';
import { withSeq } from './run-log-format.mjs';
import type { AppendItem, LogRow, RunEvent, ThreadStatus } from './run-log-types.js';
import type { SourceCatalogReply, SourceCatalogRequest } from './source-catalog-types.js';
import { type DeletionWriter, StateDeletion } from './state-deletion.js';
import { BLOBS_DIR, exportStateBundle, importStateBundle, STATE_DB } from './state-store-bundle.js';
import type {
  HydrationThread,
  IndexerPort,
  Manifest,
  PurgeReport,
  StateStoreOptions,
  StoreSettings,
  SyncSpan,
} from './state-store-types.js';
import { type Ready, waitReady } from './state-store-worker-ready.js';
import { assertNotSyncedRoot } from './sync-roots.js';
import { errorOf, logRowOf, type WorkerRow } from './worker-reply.js';
import type { WorkspaceRootReply, WorkspaceRootRequest } from './workspace-root-types.js';
import type {
  ForgeCacheReply,
  ForgeCacheRequest,
  WorktreeLedgerReply,
  WorktreeLedgerRequest,
} from './worktree-forge-types.js';

export { BLOBS_DIR, STATE_DB, sha256Hex } from './state-store-bundle.js';
/** Every entry the store creates in its data root besides the lock directory, which the lock removes itself. */
export const STORE_ENTRIES: readonly string[] = [
  STATE_DB,
  `${STATE_DB}-wal`,
  `${STATE_DB}-shm`,
  BLOBS_DIR,
];

export type { ContentClearResult as ClearContentResult } from '@brainstrike/types';

import type { ContentClearResult as ClearContentResult } from '@brainstrike/types';

export { BLOB_MIN_BYTES, largeText, PREVIEW_CHARS, type StoredText } from './large-text.js';
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

const runIdOf = (e: RunEvent): string | null =>
  typeof e['runId'] === 'string' ? e['runId'] : null;

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
  private readonly visible = new Map<string, Unreadable>();
  private chain: Promise<unknown> = Promise.resolve();
  private nextId = 0;
  private closed = false;
  private closeTask: Promise<void> | undefined;
  private closing = false;
  private failed: unknown = null;
  /** Purge, thread delete and blob GC, on this store's write chain. */
  private readonly deletion: StateDeletion;

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
    this.deletion = new StateDeletion(this.deletionWriter(), {
      indexer: () => this.indexer,
      purgeAfterTruth: () => this.options.hooks?.purgeAfterTruth?.(),
      run: (work) => this.run(work),
    });
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
        await acquired.run(async () => {
          await acquired.deletion.recover();
        });
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
    return this.deletion.requireIndexer(operation);
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
    return this.deletion.holdBlobGc();
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

  /** Mutable provider/model choices share the existing writer and mutation chain. */
  worktreeLedger(request: WorktreeLedgerRequest): Promise<WorktreeLedgerReply> {
    const execute = async (): Promise<WorktreeLedgerReply> => {
      const reply = await this.call({ op: 'worktree-ledger', request });
      return { rows: reply['rows'] as WorktreeLedgerReply['rows'] };
    };
    return ['get', 'by-path', 'list-active', 'list-repository'].includes(request.operation)
      ? execute()
      : this.run(execute);
  }

  async forgeCacheSnapshot(): Promise<readonly ForgePrCacheEntry[]> {
    const reply = await this.call({ op: 'forge-cache-snapshot' });
    return reply['entries'] as readonly ForgePrCacheEntry[];
  }

  forgeCache(request: ForgeCacheRequest): Promise<ForgeCacheReply> {
    const execute = async (): Promise<ForgeCacheReply> => {
      const reply = await this.call({ op: 'forge-cache', request });
      return { entry: reply['entry'] as ForgeCacheReply['entry'] };
    };
    return request.operation === 'get' ? execute() : this.run(execute);
  }

  /** Internal metadata port and public library operations share the same writer chain. */
  private async promptMetadata(request: PromptCatalogRequest): Promise<PromptCatalogReply> {
    const reply = await this.call({ op: 'prompt-catalog', request });
    return {
      items: reply['items'] as PromptCatalogReply['items'],
      revisions: reply['revisions'] as PromptCatalogReply['revisions'],
    };
  }
  promptCatalog(request: PromptCatalogRequest): Promise<PromptCatalogReply> {
    return this.run(() => this.promptMetadata(request));
  }
  promptLibrary(request: PromptLibraryRequest): Promise<PromptLibraryReply> {
    return this.run(() => {
      const indexer = this.requireIndexer('Prompt Library');
      if (!indexer.promptVectors) {
        throw new Error('Prompt Library requires the acquired native prompt vector owner');
      }
      return executePromptLibrary(request, (operation) => this.promptMetadata(operation), {
        promptVectors: indexer.promptVectors.bind(indexer),
      });
    });
  }

  collections(request: CollectionRequest): Promise<CollectionReply> {
    const execute = async (): Promise<CollectionReply> => {
      const reply = await this.call({ op: 'collections', request });
      return {
        collections: reply['collections'] as CollectionReply['collections'],
        ...(request.operation === 'snapshot'
          ? { counts: reply['counts'] as NonNullable<CollectionReply['counts']> }
          : {}),
      };
    };
    return request.operation === 'list' ||
      request.operation === 'snapshot' ||
      request.operation === 'get'
      ? execute()
      : this.run(execute);
  }

  threadGroups(request: ThreadGroupsRequest): Promise<ThreadGroupsReply> {
    const execute = async (): Promise<ThreadGroupsReply> => {
      const reply = await this.call({ op: 'thread-groups', request });
      return {
        groups: reply['groups'] as ThreadGroupsReply['groups'],
        placements: reply['placements'] as ThreadGroupsReply['placements'],
      };
    };
    return request.operation === 'list' ? execute() : this.run(execute);
  }

  viewFilterPresets(request: ViewFilterPresetRequest): Promise<ViewFilterPresetReply> {
    const execute = async (): Promise<ViewFilterPresetReply> => {
      const reply = await this.call({ op: 'view-filter-presets', request });
      return {
        presets: reply['presets'] as ViewFilterPresetReply['presets'],
        ...(typeof reply['deleted'] === 'boolean' ? { deleted: reply['deleted'] } : {}),
      };
    };
    return request.operation === 'list' ? execute() : this.run(execute);
  }

  modelChoices(request: ModelChoiceRequest): Promise<ModelChoiceResult> {
    const execute = async (): Promise<ModelChoiceResult> => {
      const reply = await this.call({ op: 'model-choices', request });
      return {
        models: reply['models'] as ModelChoiceSnapshot['models'],
        providers: reply['providers'] as ModelChoiceSnapshot['providers'],
        ...(reply['previous'] ? { previous: reply['previous'] as ModelChoiceSnapshot } : {}),
        ...(reply['outcome'] ? { outcome: reply['outcome'] as 'initialized' | 'preserved' } : {}),
      };
    };
    return request.operation === 'snapshot' ? execute() : this.run(execute);
  }

  /** Root identity lives on the canonical writer; Main alone supplies granted paths. */
  workspaceRoots(request: WorkspaceRootRequest): Promise<WorkspaceRootReply> {
    const execute = async (): Promise<WorkspaceRootReply> => {
      if (request.operation === 'delete') {
        this.requireIndexer('root data deletion');
      }
      const reply = await this.call({ op: 'workspace-roots', request });
      if (request.operation === 'delete') {
        await this.deletion.collectRetiredSources();
      }
      return { roots: reply['roots'] as WorkspaceRootReply['roots'] };
    };
    return request.operation === 'list' ? execute() : this.run(execute);
  }

  /** Authoritative source bytes use this writer's existing content-addressed blobs. */
  sourceCatalog(request: SourceCatalogRequest): Promise<SourceCatalogReply> {
    const mutatesSource =
      request.operation === 'import' ||
      request.operation === 'prepare' ||
      request.operation === 'replace' ||
      request.operation === 'remove';
    const execute = async (): Promise<SourceCatalogReply> => {
      // Refuse before committing bytes if their existing physical retirement owner is absent.
      if (mutatesSource) {
        this.requireIndexer('canonical source mutation');
      }
      const reply = await this.call({ op: 'source-catalog', request });
      if (mutatesSource) {
        await this.deletion.collectRetiredSources();
      }
      return {
        files: reply['files'] as SourceCatalogReply['files'],
        ...(request.operation === 'import'
          ? { imported: reply['imported'] as readonly boolean[] }
          : {}),
      };
    };
    return request.operation === 'list' ||
      request.operation === 'inventory' ||
      request.operation === 'read'
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
  purge(threadId: string, seq: number): Promise<PurgeReport> {
    return this.deletion.purge(threadId, seq);
  }

  deleteThread(threadId: string): Promise<string[]> {
    return this.deletion.deleteThread(threadId);
  }

  /** The writer worker's deletion ops (`deletion-domain.mjs`), as the shared orchestration calls them. */
  private deletionWriter(): DeletionWriter {
    const hashes = async (op: string, fields: Record<string, unknown> = {}) =>
      (await this.call({ op, ...fields }))['hashes'] as string[];
    return {
      acknowledgeSourceGc: async (acknowledged) => {
        await this.call({ hashes: acknowledged, op: 'sourceGcAcknowledge' });
      },
      damagedBlobRefs: () => hashes('damagedBlobRefs'),
      deleteIntent: async (threadId, seq) => {
        await this.call({ op: 'intentDelete', seq, threadId });
      },
      deleteThread: async (threadId) => {
        await this.call({ op: 'deleteThread', threadId });
      },
      eventRaw: async (threadId, seq) => {
        const [event] = await this.read(threadId, seq, 1);
        return event && event.seq === seq ? event.raw : undefined;
      },
      intents: async () =>
        (
          (await this.call({ op: 'intentList' }))['intents'] as Array<{
            hashes: string;
            operation: 'event' | 'thread';
            seq: number;
            threadId: string;
          }>
        ).map((intent) => ({ ...intent, hashes: JSON.parse(intent.hashes) as string[] })),
      okThreads: async () => (await this.call({ op: 'okThreads' }))['threads'] as string[],
      purge: async (threadId, seq, tombstone) => {
        await this.call({ op: 'purge', seq, threadId, tombstone });
      },
      recordIntent: async (intent) =>
        JSON.parse(
          String(
            (
              await this.call({
                hashes: JSON.stringify(intent.hashes),
                op: 'intentRecord',
                operation: intent.operation,
                seq: intent.seq,
                threadId: intent.threadId,
              })
            )['hashes']
          )
        ) as string[],
      sourceBlobRefs: () => hashes('sourceBlobRefs'),
      sourceGcCandidates: () => hashes('sourceGcCandidates'),
      storedBlobRefs: (threadId) => hashes('storedBlobRefs', { threadId }),
      unlinkBlobs: async (unlink) =>
        (await this.call({ hashes: unlink, op: 'unlinkBlobs' }))['deleted'] as string[],
    };
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
    const release = this.deletion.holdBlobGc();
    try {
      await this.run(() => undefined); // the snapshot is not older than any write issued before this call
      await this.options.hooks?.exportAfterSnapshot?.();
      return await exportStateBundle({
        beforeBlobs: () => this.options.hooks?.exportBeforeBlobs?.(),
        blobsPath: this.blobsPath,
        bundleDir,
        lock: this.lock,
        statePath: this.statePath,
      });
    } finally {
      await release();
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
    return importStateBundle(bundleDir, targetRoot);
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

  /** Terminal content deletion on the existing writer; configuration stays in place. */
  clearContent(): Promise<ClearContentResult> {
    const clearing = this.run(async () => {
      await this.indexer?.reset();
      const reply = await this.call({ op: 'clear-content' });
      const deletedFiles = reply['deletedFiles'];
      const deletedChunks = reply['deletedChunks'];
      if (
        typeof deletedFiles !== 'number' ||
        (deletedChunks !== null && typeof deletedChunks !== 'number')
      ) {
        throw new Error('Invalid content-clear writer receipt');
      }
      await this.shutdownWriter();
      this.lock.release();
      return { deletedChunks, deletedFiles };
    });
    // Fence later writers immediately, including while physical readers join.
    this.closed = true;
    this.closeTask = clearing.then(() => undefined);
    this.closeTask.catch(() => undefined);
    return clearing;
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
