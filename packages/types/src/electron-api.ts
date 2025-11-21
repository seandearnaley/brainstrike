/**
 * Type definitions for Electron IPC API exposed to renderer process
 *
 * These interfaces define the contract between the main process and renderer process
 * for database operations, file system access, and other Electron-specific features.
 */

/**
 * Result of a database test operation
 */
export interface DatabaseTestResult {
  success: boolean;
  message: string;
}

/**
 * Query result containing rows of data
 */
export interface QueryResult<T = unknown> {
  rows: T[];
}

/**
 * Electron database API exposed via IPC
 *
 * This interface defines all database operations available to the renderer process.
 * Operations are executed in the main process and results are returned via IPC.
 */
export interface ElectronDatabaseAPI {
  /**
   * Test database connection health
   * @returns Promise resolving to test result with success status and message
   */
  test?: () => Promise<DatabaseTestResult>;

  /**
   * Execute a parameterized SQL query and return results
   * @param sql SQL query string with optional parameter placeholders
   * @param params Optional array of parameter values
   * @returns Promise resolving to query results
   */
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<QueryResult<T>>;

  /**
   * Execute a SQL statement without returning rows (INSERT, UPDATE, DELETE, etc.)
   * @param sql SQL statement string with optional parameter placeholders
   * @param params Optional array of parameter values
   * @returns Promise resolving to execution result
   */
  exec?: (sql: string, params?: unknown[]) => Promise<unknown>;

  /**
   * Execute multiple statements within a transaction
   * @param fn Transaction function that receives a transaction context
   * @returns Promise resolving to the transaction result
   */
  transaction?: <T>(fn: (tx: ElectronDatabaseAPI) => Promise<T>) => Promise<T>;

  /**
   * Close database connection
   * @returns Promise resolving when connection is closed
   */
  close?: () => Promise<void>;

  /**
   * Get database file path (if applicable)
   * @returns Promise resolving to database file path or null
   */
  getPath?: () => Promise<string | null>;
}

/**
 * Electron API exposed to renderer process via preload script
 *
 * This is the top-level API object available on window.electronAPI
 */
export interface ElectronAPI {
  /**
   * Database operations
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
