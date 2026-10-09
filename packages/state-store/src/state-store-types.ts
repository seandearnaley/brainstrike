// The store's public shapes: its options, the indexer port it drives, and what its reads, purges and exports report.
// Split from state-store.ts so the facade stays one module of behaviour.
import type { ThreadDamagedError } from './errors.js';
import type { LockOptions } from './lock.js';
import type { LogRow } from './run-log-types.js';
import type { StateStoreStartupOwner } from './state-store.js';

/**
 * The indexer's side of purge and thread delete (M0-A2 src/indexer-client.ts requests). The derived store re-derives a
 * purged event and owns the blob reference counts; its one serial queue orders a purge's re-index after any pass that
 * read the old event.
 */
export interface IndexerPort {
  catchUp(threads: readonly string[]): Promise<void>;
  /** Drop everything derived from the thread; returns the blob hashes it referenced. */
  dropThread(threadId: string): Promise<readonly string[]>;
  /** Reference counts of `hashes` after catching up with every thread in `threads`. */
  gcCheck(
    threads: readonly string[],
    hashes: readonly string[]
  ): Promise<Readonly<Record<string, number>>>;
  reindex(threadId: string, seq: number): Promise<void>;
  /** Close every handle the indexer holds on the data root (factory reset). */
  reset(): Promise<void>;
}

export interface StateStoreHooks {
  readonly exportAfterSnapshot?: () => Promise<void>;
  readonly exportBeforeBlobs?: () => Promise<void>;
  readonly purgeAfterTruth?: () => void;
}

export interface CheckpointRow {
  readonly busy: number;
  readonly checkpointed: number;
  readonly log: number;
}

export interface WriteSpan {
  /** uv_hrtime clock (ms), worker side: one NORMAL commit. */
  readonly t0: number;
  readonly t1: number;
}

export interface SyncSpan extends WriteSpan {
  readonly checkpoint: { readonly before: CheckpointRow; readonly after: CheckpointRow } | null;
  readonly kind: 'FULL commit' | 'checkpoint(PASSIVE)+FULL commit';
  readonly thread: string;
}

export interface StateStoreOptions extends LockOptions {
  /** busy_timeout of the writer, which bounds how long a purge waits on a reader pinning the WAL. Default 5000. */
  readonly busyTimeoutMs?: number;
  /** WAL frames at which a step boundary checkpoints (PASSIVE) first. Default 1000, SQLite's autocheckpoint size. */
  readonly checkpointPages?: number;
  /** Crash-test seam: SIGKILL this process inside the purge transaction. */
  readonly crashTestHooks?: { readonly purgeInTxn?: 'sigkill' };
  /** F_FULLFSYNC syncs. Default: on macOS. */
  readonly fullfsync?: boolean;
  /** Home directory for the synced-root rule (tests point it at a fake home). */
  readonly home?: string;
  readonly hooks?: StateStoreHooks;
  /** Required by purge, thread delete and the replay of an interrupted purge. */
  readonly indexer?: IndexerPort;
  /** Trusted host composition only; never supplied in a client memory request. */
  readonly memoryCalculatorModule?: string;
  readonly onSyncSpan?: (span: SyncSpan) => void;
  readonly onWriteSpan?: (span: WriteSpan) => void;
  readonly startup?: StateStoreStartupOwner;
  /** 'sqlite-auto' is the kernel-sync probe's negative control only: it checkpoints inside streaming commits. */
  readonly walCheckpoint?: 'boundary' | 'sqlite-auto';
}

export interface StoreSettings {
  readonly fullfsync: number;
  readonly journalMode: string;
  readonly secureDelete: number;
  readonly sqliteVersion: string;
  readonly synchronous: number;
  readonly walAutocheckpoint: number;
}

export interface PurgeReport {
  readonly blobsDeleted: readonly string[];
  readonly derivedMs: number;
  readonly gcMs: number;
  readonly ms: number;
  readonly truthMs: number;
}

/**
 * One thread as the hydration read returns it: its first and latest append (ms since epoch, from the store's `threads`
 * row, so a damaged thread still dates honestly) and its verified rows not marked `hydrate: false`, up to its damage.
 */
export interface HydrationThread {
  readonly createdAt: number;
  readonly damage?: ThreadDamagedError;
  readonly rows: readonly LogRow[];
  readonly threadId: string;
  readonly updatedAt: number;
}

export interface ExportedThread {
  readonly threadId: string;
  readonly watermark: number;
}

export interface Manifest {
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }>;
  readonly format: 1;
  readonly sourceHost: string;
  readonly threads: readonly ExportedThread[];
}
