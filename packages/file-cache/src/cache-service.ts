import { PGlite } from '@electric-sql/pglite';
import type { FileCacheAdapter, FileCacheConfig, FileCacheStats } from './types';

/**
 * PGlite-based file cache service
 *
 * Provides persistent caching of file contents using an embedded PostgreSQL database.
 * Supports different storage backends via PGlite's virtual filesystem:
 * - IndexedDB for web browsers (idb://)
 * - Local filesystem for Node.js/Electron
 * - In-memory for testing (memory://)
 */
export class FileCacheService implements FileCacheAdapter {
  private db: PGlite | null = null;
  private config: FileCacheConfig;
  private tableName: string;
  private isInitialized = false;

  constructor(config: FileCacheConfig) {
    this.config = config;
    this.tableName = config.tableName || 'cached_files';
  }

  /**
   * Initialize the cache database and create tables
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Create PGlite instance with appropriate storage backend
      this.db = new PGlite(this.config.dataDir, {
        relaxedDurability: this.config.pgOptions?.relaxedDurability ?? true,
        ...(this.config.pgOptions?.debug && { debug: 1 }),
      });

      // Wait for database to be ready
      await this.db.waitReady;

      // Create the cached files table if it doesn't exist
      await this.createTable();

      this.isInitialized = true;
    } catch (error) {
      throw new Error(
        `Failed to initialize file cache: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Create the cached files table and folders table
   */
  private async createTable(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const createTablesSQL = `
      -- Create folders table for workspace management
      CREATE TABLE IF NOT EXISTS folders (
        folder_id TEXT PRIMARY KEY,
        folder_name TEXT NOT NULL,
        folder_path TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Create cached files table with folder organization
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        path TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        content TEXT NOT NULL,
        file_type TEXT DEFAULT 'text',
        file_size INTEGER,
        last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        etag TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (path, folder_id),
        FOREIGN KEY (folder_id) REFERENCES folders(folder_id) ON DELETE CASCADE
      );

      -- Create indexes for efficient queries
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_folder_id 
      ON ${this.tableName}(folder_id);
      
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_file_type 
      ON ${this.tableName}(file_type);
      
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_last_modified 
      ON ${this.tableName}(last_modified);

      CREATE INDEX IF NOT EXISTS idx_folders_last_accessed 
      ON folders(last_accessed);
    `;

    await this.db.exec(createTablesSQL);
  }

  /**
   * Get cached file content by path (searches across all folders by default)
   */
  async getFileContent(filePath: string, folderId?: string): Promise<string | null> {
    await this.ensureInitialized();

    try {
      let query: string;
      let params: string[];

      if (folderId) {
        query = `SELECT content FROM ${this.tableName} WHERE path = $1 AND folder_id = $2`;
        params = [filePath, folderId];
      } else {
        // Search across all folders, prioritize most recently accessed folder
        query = `
          SELECT cf.content 
          FROM ${this.tableName} cf
          JOIN folders f ON cf.folder_id = f.folder_id
          WHERE cf.path = $1 
          ORDER BY f.last_accessed DESC 
          LIMIT 1
        `;
        params = [filePath];
      }

      const result = await this.db?.query(query, params);

      if (!result || result.rows.length === 0) {
        return null;
      }

      return (result.rows[0] as { content: string }).content;
    } catch (error) {
      console.error('Error getting cached file content:', error);
      return null; // Treat cache errors as cache miss
    }
  }

  /**
   * Save file content to cache
   */
  async saveFileContent(
    filePath: string,
    content: string,
    folderId = 'default',
    options?: {
      fileType?: string;
      fileSize?: number;
      etag?: string;
    }
  ): Promise<void> {
    await this.ensureInitialized();

    try {
      // Ensure the folder exists (auto-register default folder if needed)
      if (folderId === 'default') {
        await this.registerFolder('default', 'Default Workspace');
      }

      const fileSize = options?.fileSize ?? content.length;
      const fileType = options?.fileType ?? 'text';
      const etag = options?.etag;

      await this.db?.query(
        `INSERT INTO ${this.tableName} (path, folder_id, content, file_type, file_size, etag, updated_at) 
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
         ON CONFLICT (path, folder_id) 
         DO UPDATE SET 
           content = EXCLUDED.content,
           file_type = EXCLUDED.file_type,
           file_size = EXCLUDED.file_size,
           etag = EXCLUDED.etag,
           updated_at = CURRENT_TIMESTAMP`,
        [filePath, folderId, content, fileType, fileSize, etag]
      );
    } catch (error) {
      console.error('Error saving file content to cache:', error);
      throw new Error(
        `Failed to save file to cache: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Remove file from cache
   */
  async removeFileContent(filePath: string, folderId?: string): Promise<void> {
    await this.ensureInitialized();

    try {
      if (folderId) {
        await this.db?.query(`DELETE FROM ${this.tableName} WHERE path = $1 AND folder_id = $2`, [
          filePath,
          folderId,
        ]);
      } else {
        // Remove from all folders
        await this.db?.query(`DELETE FROM ${this.tableName} WHERE path = $1`, [filePath]);
      }
    } catch (error) {
      console.error('Error removing file from cache:', error);
      throw new Error(
        `Failed to remove file from cache: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Clear all cached files
   */
  async clearCache(): Promise<void> {
    await this.ensureInitialized();

    try {
      await this.db?.query(`DELETE FROM ${this.tableName}`);
    } catch (error) {
      console.error('Error clearing cache:', error);
      throw new Error(
        `Failed to clear cache: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get all cached file paths, optionally for a specific folder
   */
  async getCachedFilePaths(folderId?: string): Promise<string[]> {
    await this.ensureInitialized();

    try {
      let query: string;
      let params: string[];

      if (folderId) {
        query = `SELECT path FROM ${this.tableName} WHERE folder_id = $1 ORDER BY last_modified DESC`;
        params = [folderId];
      } else {
        query = `SELECT path FROM ${this.tableName} ORDER BY last_modified DESC`;
        params = [];
      }

      const result = await this.db?.query(query, params);

      return result?.rows.map((row) => (row as { path: string }).path) || [];
    } catch (error) {
      console.error('Error getting cached file paths:', error);
      return [];
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<FileCacheStats> {
    await this.ensureInitialized();

    try {
      const result = await this.db?.query(`
        SELECT 
          COUNT(*) as total_files,
          SUM(LENGTH(content)) as total_size,
          MIN(last_modified) as oldest_entry,
          MAX(last_modified) as newest_entry
        FROM ${this.tableName}
      `);

      if (!result || result.rows.length === 0) {
        return {
          totalFiles: 0,
          totalSize: 0,
          oldestEntry: null,
          newestEntry: null,
        };
      }

      const row = result.rows[0] as {
        // biome-ignore lint/style/useNamingConvention: SQL column names use snake_case
        total_files: string | number;
        // biome-ignore lint/style/useNamingConvention: SQL column names use snake_case
        total_size: string | number;
        // biome-ignore lint/style/useNamingConvention: SQL column names use snake_case
        oldest_entry: string | null;
        // biome-ignore lint/style/useNamingConvention: SQL column names use snake_case
        newest_entry: string | null;
      };
      return {
        totalFiles: Number(row.total_files) || 0,
        totalSize: Number(row.total_size) || 0,
        oldestEntry: row.oldest_entry ? new Date(row.oldest_entry) : null,
        newestEntry: row.newest_entry ? new Date(row.newest_entry) : null,
      };
    } catch (error) {
      console.error('Error getting cache stats:', error);
      return {
        totalFiles: 0,
        totalSize: 0,
        oldestEntry: null,
        newestEntry: null,
      };
    }
  }

  /**
   * Clean up old cache entries
   */
  async cleanupOldEntries(maxAge: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    await this.ensureInitialized();

    try {
      const cutoffDate = new Date(Date.now() - maxAge);
      const result = await this.db?.query(
        `DELETE FROM ${this.tableName} 
         WHERE last_modified < $1`,
        [cutoffDate.toISOString()]
      );

      return result?.affectedRows || 0;
    } catch (error) {
      console.error('Error cleaning up old cache entries:', error);
      return 0;
    }
  }

  /**
   * Close the cache connection
   */
  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
      this.isInitialized = false;
    }
  }

  /**
   * Register a folder in the database
   */
  async registerFolder(folderId: string, folderName: string, folderPath?: string): Promise<void> {
    await this.ensureInitialized();

    try {
      await this.db?.query(
        `INSERT INTO folders (folder_id, folder_name, folder_path, last_accessed) 
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (folder_id) 
         DO UPDATE SET 
           folder_name = EXCLUDED.folder_name,
           folder_path = EXCLUDED.folder_path,
           last_accessed = CURRENT_TIMESTAMP`,
        [folderId, folderName, folderPath]
      );
    } catch (error) {
      // For default folder registration, log but don't throw
      if (folderId === 'default') {
        console.warn('Warning registering default folder:', error);
      } else {
        console.error('Error registering folder:', error);
        throw new Error(
          `Failed to register folder: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }
  }

  /**
   * Get folder contents as file nodes
   */
  async getFolderContents(folderId: string): Promise<
    Array<{
      path: string;
      fileType: string;
      fileSize: number;
      lastModified: Date;
    }>
  > {
    await this.ensureInitialized();

    try {
      const result = await this.db?.query(
        `SELECT path, file_type, file_size, last_modified 
         FROM ${this.tableName} 
         WHERE folder_id = $1 
         ORDER BY path`,
        [folderId]
      );

      return (
        (
          result?.rows as Array<{
            path: string;
            // biome-ignore lint/style/useNamingConvention: SQL column names use snake_case
            file_type: string;
            // biome-ignore lint/style/useNamingConvention: SQL column names use snake_case
            file_size: number;
            // biome-ignore lint/style/useNamingConvention: SQL column names use snake_case
            last_modified: string;
          }>
        )?.map((row) => ({
          path: row.path,
          fileType: row.file_type,
          fileSize: row.file_size,
          lastModified: new Date(row.last_modified),
        })) || []
      );
    } catch (error) {
      console.error('Error getting folder contents:', error);
      return [];
    }
  }

  /**
   * Clear all files for a specific folder
   */
  async clearFolder(folderId: string): Promise<void> {
    await this.ensureInitialized();

    try {
      await this.db?.query(`DELETE FROM ${this.tableName} WHERE folder_id = $1`, [folderId]);
    } catch (error) {
      console.error('Error clearing folder:', error);
      throw new Error(
        `Failed to clear folder: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get information about all registered folders
   */
  async getFolderInfo(): Promise<
    Array<{
      folderId: string;
      folderName: string;
      folderPath?: string;
      fileCount: number;
      lastAccessed: Date;
    }>
  > {
    await this.ensureInitialized();

    try {
      const result = await this.db?.query(`
        SELECT 
          f.folder_id,
          f.folder_name,
          f.folder_path,
          f.last_accessed,
          COUNT(cf.path) as file_count
        FROM folders f
        LEFT JOIN ${this.tableName} cf ON f.folder_id = cf.folder_id
        GROUP BY f.folder_id, f.folder_name, f.folder_path, f.last_accessed
        ORDER BY f.last_accessed DESC
      `);

      return (
        (
          result?.rows as Array<{
            // biome-ignore lint/style/useNamingConvention: SQL column names use snake_case
            folder_id: string;
            // biome-ignore lint/style/useNamingConvention: SQL column names use snake_case
            folder_name: string;
            // biome-ignore lint/style/useNamingConvention: SQL column names use snake_case
            folder_path: string;
            // biome-ignore lint/style/useNamingConvention: SQL column names use snake_case
            file_count: string;
            // biome-ignore lint/style/useNamingConvention: SQL column names use snake_case
            last_accessed: string;
          }>
        )?.map((row) => ({
          folderId: row.folder_id,
          folderName: row.folder_name,
          folderPath: row.folder_path,
          fileCount: Number(row.file_count),
          lastAccessed: new Date(row.last_accessed),
        })) || []
      );
    } catch (error) {
      console.error('Error getting folder info:', error);
      return [];
    }
  }

  /**
   * Save multiple files in bulk (for folder population)
   */
  async saveBulkFileContents(
    entries: Array<{
      path: string;
      content: string;
      folderId: string;
      fileType?: string;
      fileSize?: number;
      etag?: string;
    }>,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<void> {
    await this.ensureInitialized();

    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      // Use a transaction for atomicity
      await this.db.transaction(async (tx) => {
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          if (!entry) continue; // Skip undefined entries

          const fileSize = entry.fileSize ?? entry.content.length;
          const fileType = entry.fileType ?? 'text';

          await tx.query(
            `INSERT INTO ${this.tableName} (path, folder_id, content, file_type, file_size, etag, updated_at) 
             VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
             ON CONFLICT (path, folder_id) 
             DO UPDATE SET 
               content = EXCLUDED.content,
               file_type = EXCLUDED.file_type,
               file_size = EXCLUDED.file_size,
               etag = EXCLUDED.etag,
               updated_at = CURRENT_TIMESTAMP`,
            [entry.path, entry.folderId, entry.content, fileType, fileSize, entry.etag]
          );

          if (onProgress) {
            onProgress(i + 1, entries.length);
          }
        }
      });
    } catch (error) {
      console.error('Error saving bulk file contents:', error);
      throw new Error(
        `Failed to save bulk files: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Delete a folder and all its files
   */
  async deleteFolder(folderId: string): Promise<void> {
    await this.ensureInitialized();

    try {
      // Delete folder (cascade will remove files)
      await this.db?.query('DELETE FROM folders WHERE folder_id = $1', [folderId]);
    } catch (error) {
      console.error('Error deleting folder:', error);
      throw new Error(
        `Failed to delete folder: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Update folder last accessed time
   */
  async updateFolderAccess(folderId: string): Promise<void> {
    await this.ensureInitialized();

    try {
      await this.db?.query(
        'UPDATE folders SET last_accessed = CURRENT_TIMESTAMP WHERE folder_id = $1',
        [folderId]
      );
    } catch (error) {
      console.error('Error updating folder access:', error);
      // Non-fatal error, just log it
    }
  }

  /**
   * Ensure the cache is initialized before performing operations
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
  }
}
