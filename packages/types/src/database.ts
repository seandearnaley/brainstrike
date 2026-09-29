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

/**
 * How the previous session of this database ended, read from the clean-shutdown
 * marker when the database opens: `clean` (closed and marked), `unclean` (no
 * marker), or `new-database` (nothing was on disk to end).
 */
export type DatabasePreviousShutdown = 'clean' | 'unclean' | 'new-database';

export interface DatabaseDiagnosticsSnapshot {
  appDataDir: string;
  /** Set once a database handle could not be closed: it may still own the data directory until the process exits. */
  closeFailure: { message: string; stage: 'sync' | 'close' } | null;
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
  /** `null` until the database host has opened the database. */
  previousShutdown: DatabasePreviousShutdown | null;
  runtimeCorruptionRecoveryCount: number;
}

/** Query result containing rows of data. */
export interface QueryResult<T = unknown> {
  rows: T[];
}
