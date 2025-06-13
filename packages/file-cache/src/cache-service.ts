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
   * Create the cached files table
   */
  private async createTable(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        path TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        etag TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Create index on last_modified for efficient cleanup queries
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_last_modified 
      ON ${this.tableName}(last_modified);
    `;

    await this.db.exec(createTableSQL);
  }

  /**
   * Get cached file content by path
   */
  async getFileContent(filePath: string): Promise<string | null> {
    await this.ensureInitialized();

    try {
      const result = await this.db?.query(`SELECT content FROM ${this.tableName} WHERE path = $1`, [
        filePath,
      ]);

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
  async saveFileContent(filePath: string, content: string): Promise<void> {
    await this.ensureInitialized();

    try {
      await this.db?.query(
        `INSERT INTO ${this.tableName} (path, content, updated_at) 
         VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (path) 
         DO UPDATE SET 
           content = EXCLUDED.content,
           updated_at = CURRENT_TIMESTAMP`,
        [filePath, content]
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
  async removeFileContent(filePath: string): Promise<void> {
    await this.ensureInitialized();

    try {
      await this.db?.query(`DELETE FROM ${this.tableName} WHERE path = $1`, [filePath]);
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
   * Get all cached file paths
   */
  async getCachedFilePaths(): Promise<string[]> {
    await this.ensureInitialized();

    try {
      const result = await this.db?.query(
        `SELECT path FROM ${this.tableName} ORDER BY last_modified DESC`
      );

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
   * Ensure the cache is initialized before performing operations
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
  }
}
