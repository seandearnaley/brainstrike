/** Result of a database test operation. */
export interface DatabaseTestResult {
  message: string;
  success: boolean;
}

export type DatabaseChunkType = 'text' | 'code' | 'sentence' | 'recursive';

/** Serializable chunk payload shared by database transports. */
export interface DatabaseChunkInsert {
  chunkIndex: number;
  chunkSize: number;
  chunkType: DatabaseChunkType;
  content: string;
  contentHash: string;
  createdAt: string;
  embedding?: number[];
  embeddingHash?: string;
  embeddingSetId?: string;
  embeddingUpdatedAt?: string;
  endLine?: number;
  endOffset?: number;
  fileRecordId: string;
  id: string;
  startLine?: number;
  startOffset?: number;
  tokenCount: number;
  updatedAt: string;
}

export interface InsertChunksAndEnqueueEmbeddingJobsOptions {
  dimensionParameter?: 'dimensions' | 'output_dimensionality' | 'output_dimension' | null;
  model?: string | null;
  provider?:
    | 'local'
    | 'transformers'
    | 'openai'
    | 'google'
    | 'cohere'
    | 'voyage'
    | 'ollama'
    | 'lmstudio'
    | null;
  targetDimension?: number | null;
  targetEmbeddingSetId?: string | null;
}

export type DatabaseInitFailureCategory =
  | 'missing-extension'
  | 'corruption'
  | 'concurrency'
  | 'wasm-runtime'
  | 'filesystem'
  | 'migration'
  | 'unknown';

export type DatabaseInitStage = 'load-extensions' | 'open-database' | 'index-rebuild' | 'migration';

/**
 * What the DB host is about to do, posted to its manager BEFORE each long synchronous phase of
 * `init`. The host answers nothing while it runs one, so this is the manager's only chance to
 * derive that phase's deadline. `phase` is a subset of {@link DatabaseInitStage}, so the failure
 * classifier and this vocabulary cannot drift apart.
 */
export type DatabaseInitPhaseReport =
  | {
      readonly phase: Extract<DatabaseInitStage, 'open-database'>;
      /** Bytes of `pg_wal` segments on disk: an O(1) upper bound of the crash-recovery redo. */
      readonly pgWalBytes: number;
    }
  | {
      readonly index: DatabaseCrashSensitiveIndex;
      readonly phase: Extract<DatabaseInitStage, 'index-rebuild'>;
    }
  | { readonly phase: Extract<DatabaseInitStage, 'migration'> };

/**
 * Main's record of an init that timed out, `<profile>/.db-init-attempt.json`. It counts
 * consecutive timeouts in one phase; two of them stop the DB host manager from forking a third
 * host. Owned by main only: the host never reads or writes it, and a reset deletes it with the
 * profile.
 */
export interface DatabaseInitAttemptRecord {
  /** The budget that expired, in milliseconds. */
  readonly budgetMs: number;
  /** Consecutive timeouts in `phaseKey` with no successful init between them. */
  readonly consecutiveTimeouts: number;
  /** The host process that was killed, when its pid was known. */
  readonly hostPid: number | null;
  /** ISO time of the latest of them, on main's clock. */
  readonly lastTimeoutAt: string;
  /** The phase whose budget expired: `init:first-report`, `open-database`, `migration` or `index-rebuild:<schema>.<index>`. */
  readonly phaseKey: string;
  /** The report that started that phase; null when the timeout came before the first report. */
  readonly report: DatabaseInitPhaseReport | null;
  readonly version: 1;
}

export interface DatabaseInitFailureSnapshot {
  category: DatabaseInitFailureCategory;
  code?: string;
  message: string;
  name?: string;
  stack?: string;
  stage: DatabaseInitStage;
  timestamp: string;
}

/**
 * How the previous session of this database ended, read from the clean-shutdown
 * marker when the database opens: `clean` (closed and marked), `unclean` (no
 * marker), or `new-database` (nothing was on disk to end).
 */
export type DatabasePreviousShutdown = 'clean' | 'unclean' | 'new-database';

/**
 * A crash-sensitive index with the O(1) catalog sizes the crash-recovery pass reports. Mirrors
 * `CrashSensitiveIndex` in `@brainstrike/db`, which this package cannot import (the dependency
 * points the other way).
 */
export interface DatabaseCrashSensitiveIndex {
  readonly accessMethod: string;
  readonly heapBytes: number;
  readonly index: string;
  readonly indexBytes: number;
  readonly schema: string;
  readonly table: string;
  readonly toastBytes: number;
}

/** One index the crash-recovery pass rebuilt. Mirrors `CrashSensitiveIndexRebuild` in `@brainstrike/db`. */
export interface DatabaseCrashRecoveryIndexRebuild extends DatabaseCrashSensitiveIndex {
  readonly durationMs: number;
}

/** Mirrors `CrashSensitiveIndexRebuildResult` in `@brainstrike/db`. */
export interface DatabaseCrashRecoveryIndexRebuildResult {
  readonly rebuilt: readonly DatabaseCrashRecoveryIndexRebuild[];
  readonly totalDurationMs: number;
}

export interface DatabaseDiagnosticsSnapshot {
  appDataDir: string;
  /** Set once a database handle could not be closed: it may still own the data directory until the process exits. */
  closeFailure: { message: string; stage: 'sync' | 'close' } | null;
  /**
   * The crash-sensitive indexes rebuilt when this open followed an unclean shutdown; `null`
   * when no rebuild ran (a clean shutdown, a new database, or a rebuild that failed).
   */
  crashRecoveryIndexRebuild: DatabaseCrashRecoveryIndexRebuildResult | null;
  databaseLockHeld: boolean;
  databaseLockPath: string | null;
  databaseProfile: string | null;
  dataDir: string;
  hasDatabaseHandle: boolean;
  initializationAttemptCount: number;
  initializationInFlight: boolean;
  /**
   * Set by the desktop DB host manager (never by the host) when init timed out twice in one phase
   * and main stopped retrying. A consumer must read it before any other field: the rest of the
   * snapshot then describes a process that never opened the database.
   */
  initStop?: DatabaseInitAttemptRecord | null;
  lastInitializationFailure: DatabaseInitFailureSnapshot | null;
  lastInitializationStartedAt: string | null;
  lastInitializationSucceededAt: string | null;
  nodeEnv: string | null;
  /** `null` until the database host has opened the database. */
  previousShutdown: DatabasePreviousShutdown | null;
}

/** SQLSTATEs the runtime treats as database integrity errors: `XX001` data_corrupted, `XX002` index_corrupted. */
export type DatabaseCorruptionSqlstate = 'XX001' | 'XX002';

/**
 * A classified integrity error. `message` is the error's own message, or
 * `SQLSTATE <code>` when it carries none. `file`, `routine`, `schema` and
 * `table` are the identifier-only Postgres error fields; row data and SQL text
 * are never copied.
 */
export interface DatabaseCorruptionSignal {
  readonly file?: string;
  readonly message: string;
  readonly routine?: string;
  readonly schema?: string;
  readonly sqlstate: DatabaseCorruptionSqlstate;
  readonly table?: string;
}

/**
 * Where an integrity error was observed. The `db:*` members are exactly the
 * `DESKTOP_IPC_CHANNELS.db` channel strings; the rest name main-process owners.
 */
export type DatabaseIntegrityContext =
  | 'assistant:reindex'
  | 'db:chunks:insert-and-enqueue-embedding-jobs'
  | 'db:clearAll'
  | 'db:exec'
  | 'db:live-query:refresh'
  | 'db:live-query:start'
  | 'db:managed-cache:apply-batch'
  | 'db:managed-cache:invalidate-by-identity'
  | 'db:query'
  | 'db:test'
  | 'db:transaction'
  | 'dimension-index-maintenance'
  | 'maintenance';

/**
 * Later repair rungs ADD members here ('repairing', 'read-only'); nothing may
 * switch on `kind` without a `never` exhaustiveness check.
 */
export type DatabaseIntegrityState =
  | { readonly kind: 'healthy' }
  | {
      readonly kind: 'contained';
      readonly context: DatabaseIntegrityContext;
      readonly signal: DatabaseCorruptionSignal;
      /** ISO timestamp of the first classified error. */
      readonly since: string;
    };

/** `revision` increases on every state change so a reader can discard a stale snapshot. */
export interface DatabaseIntegritySnapshot {
  readonly revision: number;
  readonly state: DatabaseIntegrityState;
}

/** Query result containing rows of data. */
export interface QueryResult<T = unknown> {
  rows: T[];
}
