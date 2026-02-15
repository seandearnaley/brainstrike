import type { DirectoryHandle, FileHandle, IFileNode } from './file-system';

/**
 * Result of a database test operation
 */
export interface DatabaseTestResult {
  success: boolean;
  message: string;
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
  stage: DatabaseInitStage;
  category: DatabaseInitFailureCategory;
  timestamp: string;
  message: string;
  stack?: string;
  name?: string;
  code?: string;
}

export interface DatabaseDiagnosticsSnapshot {
  nodeEnv: string | null;
  databaseProfile: string | null;
  dataDir: string;
  appDataDir: string;
  initializationAttemptCount: number;
  initializationInFlight: boolean;
  hasDatabaseHandle: boolean;
  databaseLockHeld: boolean;
  databaseLockPath: string | null;
  lastInitializationStartedAt: string | null;
  lastInitializationSucceededAt: string | null;
  lastInitializationFailure: DatabaseInitFailureSnapshot | null;
  runtimeCorruptionRecoveryCount: number;
  lastRuntimeCorruptionAt: string | null;
  lastRuntimeCorruptionContext: string | null;
}

/**
 * Query result containing rows of data
 */
export interface QueryResult<T = unknown> {
  rows: T[];
}

/**
 * Storage API exposed via Electron IPC
 */
export interface ElectronStorageAPI {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
  clear: () => Promise<void>;
  getAllKeys: () => Promise<string[]>;
}

/**
 * File system API exposed via Electron IPC
 */
export interface ElectronFileSystemAPI {
  requestDirectoryAccess: () => Promise<DirectoryHandle>;
  readDirectory: (handle: DirectoryHandle) => Promise<IFileNode[]>;
  readFile: (handle: FileHandle) => Promise<string>;
  /**
   * Read a file directly by its absolute path.
   * Useful for loading persisted file tabs before the file tree is available.
   */
  readFileByPath: (absolutePath: string) => Promise<string>;
  exists: (path: string) => Promise<boolean>;
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
   * Basic connectivity check
   */
  ping?: () => Promise<unknown>;

  /**
   * Snapshot of database initialization diagnostics from main process.
   */
  diagnostics?: () => Promise<DatabaseDiagnosticsSnapshot>;

  /**
   * Test database connection health
   */
  test?: () => Promise<DatabaseTestResult>;

  /**
   * Execute a parameterized SQL query and return results
   */
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<QueryResult<T>>;

  /**
   * Execute a SQL statement without returning rows (INSERT, UPDATE, DELETE, etc.)
   */
  exec?: (sql: string, params?: unknown[]) => Promise<unknown>;

  /**
   * Execute multiple statements within a transaction
   */
  transaction?: <T>(fn: (tx: ElectronDatabaseAPI) => Promise<T>) => Promise<T>;

  /**
   * Close database connection
   */
  close?: () => Promise<void>;

  /**
   * Get database file path (if applicable)
   */
  getPath?: () => Promise<string | null>;

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
   * Reset the local database (desktop only)
   */
  resetLocal?: () => Promise<{ success: boolean; message?: string }>;
}

/**
 * Live query IPC helpers
 */
export interface ElectronLiveQueryAPI {
  start: (options: {
    query: string;
    params?: readonly unknown[];
    key?: string;
    mode?: 'query' | 'incremental';
    offset?: number;
    limit?: number;
  }) => Promise<{ id: number; initialResults: { rows: unknown[]; totalCount?: number } }>;
  stop: (id: number) => Promise<{ success: boolean } | undefined>;
  refresh: (payload: { id: number; offset?: number; limit?: number }) => Promise<{
    success: boolean;
    message?: string;
  }>;
  onUpdate: (callback: (payload: { id: number; results: unknown }) => void) => () => void;
}

/**
 * Assistant file-selection update payload shared across main/preload/renderer.
 */
export type AssistantSelectionMode = 'replace' | 'add' | 'remove';

export interface AssistantSelectionUpdatePayload {
  folderId: string;
  filePaths: string[];
  mode: AssistantSelectionMode;
}

/**
 * Electron API exposed to renderer process via preload script
 *
 * This is the top-level API object available on window.electronAPI
 */
export interface ElectronAPI {
  /**
   * Key/value storage bridge
   */
  storage: ElectronStorageAPI;

  /**
   * File system bridge
   */
  fileSystem: ElectronFileSystemAPI;

  /**
   * Database operations
   */
  db?: ElectronDatabaseAPI;

  /**
   * Live query helpers (desktop only)
   */
  dbLive?: ElectronLiveQueryAPI;

  /**
   * Panel layout persistence
   */
  saveLayout: (state: unknown) => Promise<{ success: boolean; message?: string }>;
  loadLayout: () => Promise<{ success: boolean; data?: unknown; message?: string }>;

  /**
   * Database path lookup (legacy)
   */
  getUserDataPath?: () => Promise<string>;

  /**
   * Legacy alias for database operations
   * @deprecated Prefer using the `db` property exposed by the preload script.
   */
  database?: ElectronDatabaseAPI;

  /**
   * Platform information
   */
  platform?: {
    name: string;
    version: string;
    arch: string;
  };

  /**
   * Application paths
   */
  paths?: {
    userData: string;
    documents: string;
    temp: string;
  };
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
