import type {
  DirectoryHandle,
  FileHandle,
  FileSystemChange,
  IFileNode,
  RootDescriptor,
  WatcherHealthEvent,
} from './file-system';
import type { TapestryColorName } from './tapestry-colors';

/**
 * Result of a database test operation
 */
export interface DatabaseTestResult {
  message: string;
  success: boolean;
}

export type ElectronChunkType = 'text' | 'code' | 'sentence' | 'recursive';

export interface ElectronChunkInsert {
  chunkIndex: number;
  chunkSize: number;
  chunkType: ElectronChunkType;
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

export interface ElectronInsertChunksAndEnqueueEmbeddingJobsOptions {
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

/**
 * Query result containing rows of data
 */
export interface QueryResult<T = unknown> {
  rows: T[];
}

export interface ManagedCacheInvalidationResult {
  readonly canceledEmbeddingJobCount: number;
  readonly deletedChunkIds: string[];
  readonly deletedFileRecordIds: string[];
}

export type DatabaseWorkPriority = 'foreground' | 'normal' | 'background';

export interface DatabaseWorkOptions {
  readonly label?: string;
  readonly priority?: DatabaseWorkPriority;
}

export interface DatabaseWorkSchedulerSnapshot {
  readonly backgroundWaiting: boolean;
  readonly backgroundWaitingSince: number | null;
  readonly backgroundYieldCount: number;
  readonly currentBackgroundWaitMs: number;
  readonly foregroundQuietMs: number;
  readonly lastBackgroundYieldAt: number | null;
  readonly lastCompletedAt: number | null;
  readonly lastForegroundAt: number | null;
  readonly lastNormalAt: number | null;
  readonly lastStartedAt: number | null;
  readonly priorityStats: Record<DatabaseWorkPriority, DatabaseWorkPriorityStats>;
  readonly queued: Record<DatabaseWorkPriority, number>;
  readonly queuedLabels: Record<DatabaseWorkPriority, readonly (string | null)[]>;
  readonly runningLabel: string | null;
  readonly runningPriority: DatabaseWorkPriority | null;
  readonly snapshotAt: number;
}

export interface DatabaseWorkPriorityStats {
  readonly completed: number;
  readonly lastCompletedLabel: string | null;
  readonly lastStartedLabel: string | null;
  readonly longestWaitMs: number;
  readonly queued: number;
  readonly serviceP50Ms: number;
  readonly serviceP95Ms: number;
  readonly started: number;
  readonly totalServiceMs: number;
  readonly totalWaitMs: number;
  readonly waitP50Ms: number;
  readonly waitP95Ms: number;
}

/**
 * Storage API exposed via Electron IPC
 */
export interface ElectronStorageAPI {
  clear: () => Promise<void>;
  getAllKeys: () => Promise<string[]>;
  getItem: (key: string) => Promise<string | null>;
  removeItem: (key: string) => Promise<void>;
  setItem: (key: string, value: string) => Promise<void>;
}

/**
 * File system API exposed via Electron IPC
 */
/**
 * A batched watcher push from Electron main (fs:watch-event), stamped with the
 * watchId returned by `watchDirectory` so a renderer holding multiple watches
 * can route changes to the right subscription.
 */
export interface FileSystemWatchEvent {
  changes: FileSystemChange[];
  watchId: string;
}

export interface ElectronFileSystemAPI {
  /**
   * Multi-root: pick a directory and persist it as a new root with a generated
   * RootId. requestDirectoryAccess() is the legacy single-root shim over this.
   */
  addRoot: () => Promise<RootDescriptor>;
  exists: (path: string) => Promise<boolean>;
  /** Compact main-process watcher telemetry snapshot. */
  getWatcherTelemetry: () => Promise<{
    activeWatchers: number;
    cleanups: number;
    failures: number;
    healthPushes: number;
    retries: number;
  }>;
  /**
   * Subscribe to fs:watch-event pushes (batched changes from main-process
   * watchers). Returns an unsubscribe function.
   */
  onWatchEvent: (callback: (event: FileSystemWatchEvent) => void) => () => void;
  /**
   * Subscribe to fs:watch-health pushes (typed watcher health transitions,
   * BST-568 slice 3). Returns an unsubscribe function.
   */
  onWatchHealth: (callback: (event: WatcherHealthEvent) => void) => () => void;
  readDirectory: (handle: DirectoryHandle) => Promise<IFileNode[]>;
  readFile: (handle: FileHandle) => Promise<string>;
  /**
   * Read a file directly by its absolute path.
   * Useful for loading persisted file tabs before the file tree is available.
   */
  readFileByPath: (absolutePath: string) => Promise<string>;
  /**
   * Multi-root: forget a persisted root by its RootId (removes the rootsList
   * entry and a matching lastFolderPath). Disconnect ≠ delete — DB rows are
   * deliberately KEPT so re-adding the same folder resumes without re-indexing.
   */
  removeRoot: (rootId: string) => Promise<void>;
  requestDirectoryAccess: () => Promise<DirectoryHandle>;
  restoreLastFolder: () => Promise<DirectoryHandle | null>;
  /**
   * Multi-root: return every persisted root with its current permission state.
   * Never prompts; never throws on individual stale roots — stale entries are
   * pruned and omitted from the result.
   */
  restoreRoots: () => Promise<RootDescriptor[]>;
  /**
   * Deliberate manual retry of a failed main-process watcher. Main enforces
   * ownership, single-flight, and escalating minimum retry intervals.
   */
  retryWatch: (watchId: string) => Promise<
    | { retried: true }
    | {
        reason: 'in-flight' | 'not-failed' | 'throttled' | 'unknown';
        retried: false;
        retryAfterMs?: number;
      }
  >;
  saveLastFolder: (folderPath: string) => Promise<void>;
  /** Stop a main-process watcher previously started via `watchDirectory`. */
  unwatchDirectory: (watchId: string) => Promise<void>;
  /**
   * Start a recursive main-process watcher for a directory. Changes arrive
   * via `onWatchEvent`, stamped with the returned watchId.
   */
  watchDirectory: (handle: DirectoryHandle) => Promise<{ watchId: string }>;
}

/**
 * Electron database API exposed via IPC
 *
 * Operations are executed in the main process and results are returned via IPC.
 */
export interface ElectronDatabaseAPI {
  /**
   * Apply a managed cache import/replace batch atomically.
   */
  applyManagedCacheBatch?: (payload: unknown, options?: DatabaseWorkOptions) => Promise<void>;

  /**
   * Clear all stored data (desktop only)
   */
  clearAll?: (confirmationToken?: string) => Promise<{
    success: boolean;
    message?: string;
    deletedFiles?: number;
    deletedChunks?: number;
  }>;

  /**
   * Close database connection
   */
  close?: () => Promise<void>;

  /**
   * Snapshot of database initialization diagnostics from main process.
   */
  diagnostics?: () => Promise<DatabaseDiagnosticsSnapshot>;

  /**
   * Execute a SQL statement without returning rows (INSERT, UPDATE, DELETE, etc.)
   */
  exec?: (sql: string, params?: unknown[], options?: DatabaseWorkOptions) => Promise<unknown>;

  /**
   * Get database file path (if applicable)
   */
  getPath?: () => Promise<string | null>;

  /**
   * Insert file chunks and enqueue their embedding jobs atomically in the DB host.
   */
  insertChunksAndEnqueueEmbeddingJobs?: (
    chunks: readonly ElectronChunkInsert[],
    fileRecordId: string,
    options: ElectronInsertChunksAndEnqueueEmbeddingJobsOptions,
    workOptions?: DatabaseWorkOptions
  ) => Promise<void>;

  /**
   * Invalidate managed cache entries by embedding set, root id, and relative path identity.
   */
  invalidateManagedCacheEntriesByIdentity?: (
    payload: unknown,
    options?: DatabaseWorkOptions
  ) => Promise<ManagedCacheInvalidationResult>;
  /**
   * Basic connectivity check
   */
  ping?: () => Promise<unknown>;

  /**
   * Execute a parameterized SQL query and return results
   */
  query: <T = unknown>(
    sql: string,
    params?: unknown[],
    options?: DatabaseWorkOptions
  ) => Promise<QueryResult<T>>;

  /**
   * Reset the local database (desktop only)
   */
  resetLocal?: () => Promise<{ success: boolean; message?: string }>;

  /**
   * Atomic transaction over IPC (#1141): run `statements` in order inside ONE
   * `pglite.transaction()` in the main process and return the rows of
   * `statements[resultIndex]`. Distinct from `transaction` above because a callback
   * can't cross the IPC boundary — the statements are shipped as data. PGlite's
   * transaction lock serializes a concurrent `query()` (e.g. the FTS half of a hybrid
   * search) so it can't interleave.
   */
  runTransaction?: (
    statements: {
      params?: unknown[];
      sql: string;
    }[],
    resultIndex: number,
    options?: DatabaseWorkOptions
  ) => Promise<{ rows: unknown[] }>;

  /**
   * Snapshot of main-process foreground/background database scheduler state.
   */
  schedulerSnapshot?: () => Promise<DatabaseWorkSchedulerSnapshot>;

  /**
   * Test database connection health
   */
  test?: () => Promise<DatabaseTestResult>;

  /**
   * Execute multiple statements within a transaction
   */
  transaction?: <T>(fn: (tx: ElectronDatabaseAPI) => Promise<T>) => Promise<T>;
}

/**
 * Live query IPC helpers
 */
export interface ElectronLiveQueryAPI {
  onUpdate: (callback: (payload: { id: number; results: unknown }) => void) => () => void;
  refresh: (
    payload: { id: number; offset?: number; limit?: number },
    options?: DatabaseWorkOptions
  ) => Promise<{
    success: boolean;
    message?: string;
  }>;
  start: (
    options: {
      query: string;
      params?: readonly unknown[];
      key?: string;
      mode?: 'query' | 'incremental';
      offset?: number;
      limit?: number;
    },
    workOptions?: DatabaseWorkOptions
  ) => Promise<{ id: number; initialResults: { rows: unknown[]; totalCount?: number } }>;
  stop: (id: number) => Promise<{ success: boolean } | undefined>;
}

/**
 * Assistant file-selection update payload shared across main/preload/renderer.
 */
export type AssistantSelectionMode = 'replace' | 'add' | 'remove';

export interface AssistantSelectionUpdatePayload {
  filePaths: string[];
  folderId: string;
  mode: AssistantSelectionMode;
}

// Keep these mode unions aligned with the canonical Zod schemas in
// @brainstrike/agent tools/schemas. This leaf package cannot import them
// directly without creating an agent -> types cycle.
export type AssistantWorkspaceContextSelectionMode = 'replace' | 'add' | 'remove';

export interface AssistantWorkspaceContextSelectionUpdatePayload {
  filePaths: string[];
  folderId: string;
  mode: AssistantWorkspaceContextSelectionMode;
  /** DB roots.id of the target root (diagnostic; the renderer routes by rootPath). */
  rootId?: string;
  /**
   * Multi-root: absolute path of the target root. The renderer maps this to the
   * client RootId (via rootDescriptors) to route the update to the right folder.
   * Present only when the assistant targeted a specific `root`; absent for the
   * legacy single-/focused-root path (route by folderId then).
   */
  rootPath?: string;
}

export type AssistantWorkspaceTapestryUpdateMode = 'replace' | 'add' | 'clear';

export interface AssistantWorkspaceTapestryRangePayload {
  color?: TapestryColorName;
  endLine: number;
  isActive?: boolean;
  startLine: number;
}

export interface AssistantWorkspaceTapestryFileUpdatePayload {
  path: string;
  ranges: AssistantWorkspaceTapestryRangePayload[];
}

export interface AssistantWorkspaceTapestryUpdatePayload {
  folderId: string;
  mode: AssistantWorkspaceTapestryUpdateMode;
  /** DB roots.id of the target root (diagnostic; the renderer routes by rootPath). */
  rootId?: string;
  /**
   * Multi-root: absolute path of the target root. The renderer maps this to the
   * client RootId to route the update. Present only when the assistant targeted
   * a specific `root`; absent for the legacy single-/focused-root path.
   */
  rootPath?: string;
  updates: AssistantWorkspaceTapestryFileUpdatePayload[];
}

/**
 * Electron API exposed to renderer process via preload script
 *
 * This is the top-level API object available on window.electronAPI
 */
export interface ElectronAPI {
  /**
   * Legacy alias for database operations
   * @deprecated Prefer using the `db` property exposed by the preload script.
   */
  database?: ElectronDatabaseAPI;

  /**
   * Database operations
   */
  db?: ElectronDatabaseAPI;

  /**
   * Live query helpers (desktop only)
   */
  dbLive?: ElectronLiveQueryAPI;

  /**
   * File system bridge
   */
  fileSystem: ElectronFileSystemAPI;

  /**
   * Database path lookup (legacy)
   */
  getUserDataPath?: () => Promise<string>;
  loadLayout: () => Promise<{ success: boolean; data?: unknown; message?: string }>;

  /**
   * Application paths
   */
  paths?: {
    userData: string;
    documents: string;
    temp: string;
  };

  /**
   * Platform information
   */
  platform?: {
    name: string;
    version: string;
    arch: string;
  };

  /**
   * Panel layout persistence
   */
  saveLayout: (state: unknown) => Promise<{ success: boolean; message?: string }>;
  /**
   * Key/value storage bridge
   */
  storage: ElectronStorageAPI;
}

/**
 * Global window augmentation for Electron renderer process
 */
declare global {
  interface Window {
    /**
     * Electron IPC API
     * Only available when running in Electron renderer process
     */
    electronAPI?: ElectronAPI;
  }
}
