// The state store of one data root (ADR-0011): the run log plus the small authoritative tables in `<root>/state.db`,
// content-addressed blobs in `<root>/blobs/`, the root lock in `<root>/lock/`. Electron-free (ADR-0017): the data root
// is a constructor parameter.
//
// The write side is M0-A1's SqliteStore (src/store-sqlite.ts): this thread only posts messages to the writer worker
// (src/writer-worker.mjs), which holds the ONLY writing connection; an append resolves only after its COMMIT returned;
// a failed write or an unexpected worker exit fails the store, never a hang or a silent drop.
// The lifecycle is M0-A2's Host (src/host.ts) without the run host: synced-root refusal and the root lock at open, a
// damaged DB opened read-only and visibly, purge orchestration with a crash-replayable intent, reset.
// Every mutation runs on ONE write chain, so a purge's blob GC can never race an append that references the blob.
// Mastra's memory calculation runs on a second worker that only calculates (memory-calculator.ts); its results commit
// on the writer, on that chain.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  ThreadGroupsReply,
  ThreadGroupsRequest,
  ViewFilterPresetReply,
  ViewFilterPresetRequest,
} from '@brainstrike/types';
import { ThreadDamagedError, ThreadReadOnlyError } from './errors.ts';
import {
  type Decoded,
  decodeEvent,
  type EventSchema,
  type Mode,
  type Unreadable,
} from './event-schema.ts';
import { RootLock } from './lock.ts';
import type { McpTaskDomainReply, McpTaskDomainRequest } from './mcp-task-types.ts';
import { MemoryCalculator } from './memory-calculator.ts';
import type {
  MemoryDomainPort,
  MemoryDomainRequest,
  MemoryNativeRequest,
  MemorySharedObservations,
  MemorySnapshot,
  MemoryWriterRequest,
} from './memory-types.ts';
import type {
  ModelChoiceRequest,
  ModelChoiceResult,
  ModelChoiceSnapshot,
} from './model-choice-types.ts';
import { withSeq } from './run-log-format.mjs';
import type { AppendItem, LogRow, RunEvent, ThreadStatus } from './run-log-types.ts';
import { type DeletionWriter, StateDeletion } from './state-deletion.ts';
import type {
  HydrationThread,
  IndexerPort,
  PurgeReport,
  StateStoreOptions,
  StoreSettings,
  SyncSpan,
} from './state-store-types.ts';
import { type Ready, waitReady } from './state-store-worker-ready.ts';
import { assertNotSyncedRoot } from './sync-roots.ts';
import { errorOf, logRowOf, type WorkerRow } from './worker-reply.ts';
import type { WorkspaceRootReply, WorkspaceRootRequest } from './workspace-root-types.ts';
import type { WorktreeLedgerReply, WorktreeLedgerRequest } from './worktree-ledger-types.ts';

export const STATE_DB = 'state.db';
export const BLOBS_DIR = 'blobs';
export const sha256Hex = (b: Buffer | string): string =>
  createHash('sha256').update(b).digest('hex');
/** Every entry the store creates in its data root besides the lock directory, which the lock removes itself. */
export const STORE_ENTRIES: readonly string[] = [
  STATE_DB,
  `${STATE_DB}-wal`,
  `${STATE_DB}-shm`,
  BLOBS_DIR,
];

export { BLOB_MIN_BYTES, largeText, PREVIEW_CHARS, type StoredText } from './large-text.ts';
export type {
  HydrationThread,
  IndexerPort,
  PurgeReport,
  StateStoreHooks,
  StateStoreOptions,
  StoreSettings,
  SyncSpan,
  WriteSpan,
} from './state-store-types.ts';

/** Trusted host composition after writer readiness, before interrupted purge replay. */
export interface StateStoreStartupOwner {
  acquire(store: StateStore): Promise<IndexerPort | undefined>;
  /** Failed startup joins external resources before the canonical writer or Root can close. */
  close(): Promise<void>;
}

/** Failed startup retains the original writer and Root when external cleanup is unproved. */
export class StateStoreStartupError extends AggregateError {
  readonly store: StateStore;

  constructor(causes: readonly unknown[], store: StateStore) {
    super(causes, 'State startup cleanup failed; durable root ownership is retained');
    this.store = store;
  }
}

type Reply = Readonly<Record<string, unknown>> & {
  readonly id: number;
  readonly error?: string;
  readonly errorKind?: 'readonly' | 'store-readonly' | 'damaged' | 'checkpoint-blocked' | 'failed';
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
  private readonly worker: Worker;
  private readonly options: StateStoreOptions;
  private indexer: IndexerPort | undefined;
  private readonly waiters = new Map<number, Waiter>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly visible = new Map<string, Unreadable>();
  private chain: Promise<unknown> = Promise.resolve();
  /** Each memory resource's mutations, one at a time in arrival order; a key exists while one is queued or running. */
  private readonly memoryLanes = new Map<string, Promise<void>>();
  private readonly calculator: MemoryCalculator;
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
    this.calculator = new MemoryCalculator(options.memoryCalculatorModule);
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
        await acquired.withMemoryLanes(await acquired.memoryResources(), () =>
          acquired.run(async () => {
            await acquired.deletion.recover();
          })
        );
      }
      store.calculator.start();
      return store;
    } catch (e) {
      if (store && options.startup) {
        try {
          await options.startup.close();
        } catch (cleanup) {
          throw new StateStoreStartupError([e, cleanup], store);
        }
      }
      // Interrupted-delete replay may have started the memory calculator.
      await store?.calculator.close();
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
    return this.enqueue(fn);
  }

  /** The write chain for work admitted before close: a memory mutation's commit, which close waits for. */
  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  // ---- run log --------------------------------------------------------------------------------------------------------

  /**
   * Append rows (possibly across threads) as ONE NORMAL commit. It resolves only after the COMMIT returned, so a caller
   * that displays rows once it resolves never shows one a process crash loses. `full` makes the rows and the existing
   * run_sync marker one FULL transaction, so terminal success is never committed ahead of its kernel sync. A write
   * failure fails the store (later calls are refused, so no seq is ever reused); a damaged thread refuses the batch
   * without failing the store.
   */
  append(
    items: readonly AppendItem[],
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
          const seqs = r['seqs'] as number[];
          return items.map((it, i): LogRow => {
            const raw = withSeq(seqs[i] as number, bodies[i] as string);
            return {
              event: JSON.parse(raw) as RunEvent,
              raw,
              seq: seqs[i] as number,
              threadId: it.threadId,
              ts: Number(r['ts']),
            };
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
      threadId: string;
      ts: number;
    }>;
    return rows.map((row) => ({
      event: JSON.parse(row.payload) as RunEvent,
      raw: row.payload,
      seq: row.seq,
      threadId: row.threadId,
      ts: row.ts,
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

  /**
   * Native metadata/WM/OM commit on this same writer and write chain; transcript stays in the log. Reads run directly.
   * One resource's mutations run one at a time, in arrival order. A native request reads the resource's snapshot,
   * the memory calculator worker calculates its delta, and the delta commits on the write chain only while the
   * resource's revision is still the one it read; appends and other resources go on during the calculation. Purge and
   * thread deletion enter the same lanes. The revision check stays the backstop: a write that changed the resource in
   * between fails the request visibly, with no retry.
   */
  memory(request: MemoryDomainRequest): Promise<MemorySnapshot> {
    if (request.operation === 'read') {
      return this.memoryWrite(request);
    }
    if (this.closed) {
      return Promise.reject(new Error('StateStore is closed'));
    }
    if (request.operation === 'native' && !this.calculator.available) {
      return Promise.reject(new Error('Native memory calculator capability is unavailable'));
    }
    return this.memoryLane(request.resourceId, () => {
      if (request.operation === 'native') {
        return this.nativeMemory(request);
      }
      if (request.operation === 'purge-thread' && request.sharedResource === 'detach-thread') {
        return this.detachThreadMemory(request);
      }
      return this.enqueue(() => this.memoryWrite(request));
    });
  }

  /**
   * Purge and thread deletion change their thread's memory resources on the write chain. They enter those resources'
   * lanes first, so a memory request admitted earlier commits first and one admitted later reads what they leave.
   * Lanes are entered in sorted order; only these multi-resource holders take more than one.
   */
  private withMemoryLanes<T>(resourceIds: readonly string[], work: () => Promise<T>): Promise<T> {
    const [first, ...rest] = [...new Set(resourceIds)].sort();
    return first === undefined
      ? work()
      : this.memoryLane(first, () => this.withMemoryLanes(rest, work));
  }

  /** The thread's memory resources, or with no thread every resource a recorded deletion intent names. */
  private async memoryResources(threadId?: string): Promise<string[]> {
    return (await this.call({ op: 'memory-resources', threadId }))['resources'] as string[];
  }

  private memoryLane<T>(resourceId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.memoryLanes.get(resourceId);
    const p = previous ? previous.then(work) : work();
    const tail = p.then(
      () => undefined,
      () => undefined
    );
    this.memoryLanes.set(resourceId, tail);
    tail.then(() => {
      if (this.memoryLanes.get(resourceId) === tail) {
        this.memoryLanes.delete(resourceId);
      }
    });
    return p;
  }

  private async memoryWrite(
    request: MemoryWriterRequest,
    detached?: MemorySharedObservations
  ): Promise<MemorySnapshot> {
    return (await this.call({ detached, op: 'memory', request }))['snapshot'] as MemorySnapshot;
  }

  private async nativeMemory(request: MemoryNativeRequest): Promise<MemorySnapshot> {
    const owner =
      request.ownerThreadId === undefined ? {} : { ownerThreadId: request.ownerThreadId };
    const current = await this.memoryWrite({
      operation: 'read',
      resourceId: request.resourceId,
      ...owner,
    });
    const { changes, value } = await this.calculator.calculate(current, request);
    const committed =
      changes.length === 0
        ? current
        : await this.enqueue(() =>
            this.memoryWrite({
              changes,
              expectedRevision: current.revision,
              operation: 'commit',
              resourceId: request.resourceId,
              ...owner,
            })
          );
    return { ...committed, value };
  }

  private async detachThreadMemory(
    request: Extract<MemoryWriterRequest, { operation: 'purge-thread' }>
  ): Promise<MemorySnapshot> {
    const shared = (
      await this.call({ op: 'memory-shared-observations', resourceId: request.resourceId })
    )['shared'] as MemorySharedObservations[];
    const [detached] = await this.calculator.detach(shared, request.threadId);
    return this.enqueue(() => this.memoryWrite(request, detached));
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

  threadGroups(request: ThreadGroupsRequest): Promise<ThreadGroupsReply> {
    const execute = async (): Promise<ThreadGroupsReply> => {
      const reply = await this.call({ op: 'thread-groups', request });
      return {
        groups: reply['groups'] as ThreadGroupsReply['groups'],
        pins: reply['pins'] as ThreadGroupsReply['pins'],
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
      const reply = await this.call({ op: 'workspace-roots', request });
      return { roots: reply['roots'] as WorkspaceRootReply['roots'] };
    };
    return request.operation === 'list' ? execute() : this.run(execute);
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
    return this.withMemoryLanes(await this.memoryResources(threadId), () =>
      this.deletion.purge(threadId, seq)
    );
  }

  async deleteThread(threadId: string): Promise<string[]> {
    return this.withMemoryLanes(await this.memoryResources(threadId), () =>
      this.deletion.deleteThread(threadId)
    );
  }

  /** The writer worker's deletion ops (`deletion-domain.mjs`), as the shared orchestration calls them. */
  private deletionWriter(): DeletionWriter {
    const hashes = async (op: string, fields: Record<string, unknown> = {}) =>
      (await this.call({ op, ...fields }))['hashes'] as string[];
    return {
      damagedBlobRefs: () => hashes('damagedBlobRefs'),
      deleteIntent: async (threadId, seq) => {
        await this.call({ op: 'intentDelete', seq, threadId });
      },
      // On the write chain: no memory write lands between this read and the deletion's commit, which checks the
      // revisions the shared observations were read at.
      deleteThread: async (threadId) => {
        const shared = (await this.call({ op: 'memory-shared-observations', threadId }))[
          'shared'
        ] as MemorySharedObservations[];
        const detached = await this.calculator.detach(shared, threadId);
        await this.call({ detached, op: 'deleteThread', threadId });
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
      storedBlobRefs: (threadId) => hashes('storedBlobRefs', { threadId }),
      unlinkBlobs: async (unlink) =>
        (await this.call({ hashes: unlink, op: 'unlinkBlobs' }))['deleted'] as string[],
    };
  }

  // ---- reset / close --------------------------------------------------------------------------------------------------

  private async shutdownWriter(): Promise<void> {
    const database = await Promise.allSettled([this.call({ op: 'close' })]);
    this.closing = true;
    // better-sqlite3 closes every connection on the worker's environment teardown.
    // Preserve a database rejection even when physical termination also rejects.
    const writer = await Promise.allSettled([this.worker.terminate(), this.calculator.close()]);
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
  clearContent(): Promise<void> {
    const clearing = this.run(async () => {
      await this.indexer?.reset();
      await this.call({ op: 'clear-content' });
      await this.shutdownWriter();
      this.lock.release();
    });
    // Fence later writers immediately, including while physical readers join.
    this.closed = true;
    this.closeTask = clearing;
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
    // A memory mutation admitted before close commits on the chain when its calculation returns.
    await Promise.all(this.memoryLanes.values());
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
