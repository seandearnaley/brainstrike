import type { PGlite } from '@electric-sql/pglite';

export interface FileCacheAdapter {
  /**
   * Get cached file content by path
   */
  getFileContent(filePath: string): Promise<string | null>;

  /**
   * Save file content to cache
   */
  saveFileContent(filePath: string, content: string): Promise<void>;

  /**
   * Remove file from cache
   */
  removeFileContent(filePath: string): Promise<void>;

  /**
   * Clear all cached files
   */
  clearCache(): Promise<void>;

  /**
   * Get all cached file paths
   */
  getCachedFilePaths(): Promise<string[]>;

  /**
   * Get cache statistics
   */
  getStats(): Promise<FileCacheStats>;

  /**
   * Initialize the cache (create tables, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Close the cache connection
   */
  close(): Promise<void>;
}

export interface FileCacheConfig {
  /**
   * Data directory for PGlite storage
   * - For web: use 'idb://cache-name' for IndexedDB
   * - For electron: use file path for filesystem storage
   * - For tests: use 'memory://' for in-memory storage
   */
  dataDir: string;

  /**
   * Optional configuration for PGlite
   */
  pgOptions?: {
    relaxedDurability?: boolean;
    debug?: boolean;
  };

  /**
   * Optional table name for cached files (defaults to 'cached_files')
   */
  tableName?: string;
}

export interface CachedFileEntry {
  path: string;
  content: string;
  lastModified: Date;
  etag?: string;
}

export interface FileCacheStats {
  totalFiles: number;
  totalSize: number;
  oldestEntry: Date | null;
  newestEntry: Date | null;
}

export type { PGlite };
