import type { PGlite } from '@electric-sql/pglite';

export interface FileCacheAdapter {
  /**
   * Get cached file content by path (optionally scoped to folder)
   */
  getFileContent(filePath: string, folderId?: string): Promise<string | null>;

  /**
   * Save file content to cache
   */
  saveFileContent(
    filePath: string,
    content: string,
    folderId?: string,
    options?: {
      fileType?: string;
      fileSize?: number;
      etag?: string;
    }
  ): Promise<void>;

  /**
   * Remove file from cache (optionally scoped to folder)
   */
  removeFileContent(filePath: string, folderId?: string): Promise<void>;

  /**
   * Clear all cached files
   */
  clearCache(): Promise<void>;

  /**
   * Get all cached file paths (optionally scoped to folder)
   */
  getCachedFilePaths(folderId?: string): Promise<string[]>;

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

  // New folder management methods
  /**
   * Register a folder in the database
   */
  registerFolder(folderId: string, folderName: string, folderPath?: string): Promise<void>;

  /**
   * Get folder contents as file metadata
   */
  getFolderContents(folderId: string): Promise<FolderFileEntry[]>;

  /**
   * Clear all files for a specific folder
   */
  clearFolder(folderId: string): Promise<void>;

  /**
   * Get information about all registered folders
   */
  getFolderInfo(): Promise<FolderInfo[]>;

  /**
   * Save multiple files in bulk (for folder population)
   */
  saveBulkFileContents(
    entries: BulkFileEntry[],
    onProgress?: (loaded: number, total: number) => void
  ): Promise<void>;

  /**
   * Delete a folder and all its files
   */
  deleteFolder(folderId: string): Promise<void>;

  /**
   * Update folder last accessed time
   */
  updateFolderAccess(folderId: string): Promise<void>;
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

export interface FolderFileEntry {
  path: string;
  fileType: string;
  fileSize: number;
  lastModified: Date;
}

export interface FolderInfo {
  folderId: string;
  folderName: string;
  folderPath?: string;
  fileCount: number;
  lastAccessed: Date;
}

export interface BulkFileEntry {
  path: string;
  content: string;
  folderId: string;
  fileType?: string;
  fileSize?: number;
  etag?: string;
}

export interface FileCacheStats {
  totalFiles: number;
  totalSize: number;
  oldestEntry: Date | null;
  newestEntry: Date | null;
}

export type { PGlite };
