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

export type DatabaseInitStage =
  | 'load-extensions'
  | 'open-database'
  | 'migration'
  | 'runtime-corruption-recovery';

export interface DatabaseInitFailureSnapshot {
  category: DatabaseInitFailureCategory;
  code?: string;
  message: string;
  name?: string;
  stack?: string;
  stage: DatabaseInitStage;
  timestamp: string;
}

export interface DatabaseDiagnosticsSnapshot {
  appDataDir: string;
  databaseLockHeld: boolean;
  databaseLockPath: string | null;
  databaseProfile: string | null;
  dataDir: string;
  hasDatabaseHandle: boolean;
  initializationAttemptCount: number;
  initializationInFlight: boolean;
  lastInitializationFailure: DatabaseInitFailureSnapshot | null;
  lastInitializationStartedAt: string | null;
  lastInitializationSucceededAt: string | null;
  lastRuntimeCorruptionAt: string | null;
  lastRuntimeCorruptionContext: string | null;
  nodeEnv: string | null;
  runtimeCorruptionRecoveryCount: number;
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
  | 'embedding-host:enqueue-backfill'
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
