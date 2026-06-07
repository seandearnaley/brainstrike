import type { DirectoryHandle, FileHandle, IFileNode } from './file-system';
import type { TapestryColorName } from './tapestry-colors';

/**
 * Result of a database test operation
 */
export interface DatabaseTestResult {
  message: string;
  success: boolean;
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
export interface ElectronFileSystemAPI {
  exists: (path: string) => Promise<boolean>;
  readDirectory: (handle: DirectoryHandle) => Promise<IFileNode[]>;
  readFile: (handle: FileHandle) => Promise<string>;
  /**
   * Read a file directly by its absolute path.
   * Useful for loading persisted file tabs before the file tree is available.
   */
  readFileByPath: (absolutePath: string) => Promise<string>;
  requestDirectoryAccess: () => Promise<DirectoryHandle>;
  restoreLastFolder: () => Promise<DirectoryHandle | null>;
  saveLastFolder: (folderPath: string) => Promise<void>;
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
