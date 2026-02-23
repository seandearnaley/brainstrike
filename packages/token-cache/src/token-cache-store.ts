/**
 * Token Cache Store
 *
 * PGlite-backed persistent storage for token counts.
 * Provides efficient batch queries and aggregations.
 */

import { createLogger, validateRelativeFilePath } from '@brainstrike/utils';
import type { PGlite } from '@electric-sql/pglite';
import type {
  TokenCacheEntry,
  TokenCacheStats,
  TokenCacheStoreOptions,
  TokenCountingMode,
} from './types';

const logger = createLogger('TokenCacheStore');
/**
 * Database row type (snake_case from SQL)
 */
interface TokenCacheRow {
  id: number;
  folder_id: string;
  file_path: string;
  content_hash: string;
  file_size: string; // BIGINT comes as string
  mtime_ms: string | null;
  token_count: number;
  counting_mode: string;
  model_encoding: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Convert database row to TokenCacheEntry
 */
function rowToEntry(row: TokenCacheRow): TokenCacheEntry {
  return {
    folderId: row.folder_id,
    filePath: row.file_path,
    contentHash: row.content_hash,
    fileSize: Number(row.file_size),
    mtimeMs: row.mtime_ms ? Number(row.mtime_ms) : null,
    tokenCount: row.token_count,
    countingMode: row.counting_mode as TokenCountingMode,
    modelEncoding: row.model_encoding,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * TokenCacheStore provides persistent storage for token counts using PGlite.
 *
 * Features:
 * - Efficient batch queries for multiple files
 * - SQL aggregations for total token counts
 * - Automatic upsert on conflict
 * - Folder-level cache clearing
 */
export class TokenCacheStore {
  private readonly db: PGlite;

  constructor(db: PGlite, _options: TokenCacheStoreOptions = {}) {
    this.db = db;
  }

  private validateFilePath(filePath: string): string {
    try {
      const validatedPath = validateRelativeFilePath(filePath);
      if (validatedPath !== validatedPath.trim()) {
        logger.info(
          'Token cache file path has leading or trailing whitespace; preserving exact key',
          {
            filePath: validatedPath,
          }
        );
      }
      return validatedPath;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn('Rejected unsafe token cache file path', { filePath, reason });
      throw error;
    }
  }

  private async upsertEntryWithValidatedPath(
    entry: TokenCacheEntry,
    validatedPath: string
  ): Promise<void> {
    if (process.env['NODE_ENV'] !== 'production' && validatedPath !== entry.filePath) {
      throw new Error('Invariant violated: validatedPath must equal entry.filePath');
    }

    await this.db.query(
      `INSERT INTO file_token_cache
       (folder_id, file_path, content_hash, file_size, mtime_ms,
        token_count, counting_mode, model_encoding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (folder_id, file_path)
       DO UPDATE SET
         content_hash = EXCLUDED.content_hash,
         file_size = EXCLUDED.file_size,
         mtime_ms = EXCLUDED.mtime_ms,
         token_count = EXCLUDED.token_count,
         counting_mode = EXCLUDED.counting_mode,
         model_encoding = EXCLUDED.model_encoding,
         updated_at = CURRENT_TIMESTAMP`,
      [
        entry.folderId,
        validatedPath,
        entry.contentHash,
        entry.fileSize,
        entry.mtimeMs,
        entry.tokenCount,
        entry.countingMode,
        entry.modelEncoding,
      ]
    );
  }

  /**
   * Get a single cached entry by folder and path.
   */
  async get(folderId: string, filePath: string): Promise<TokenCacheEntry | null> {
    const validatedPath = this.validateFilePath(filePath);
    const result = await this.db.query<TokenCacheRow>(
      `SELECT * FROM file_token_cache
       WHERE folder_id = $1 AND file_path = $2`,
      [folderId, validatedPath]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return rowToEntry(row);
  }

  /**
   * Get multiple cached entries in a single query.
   * Returns a Map keyed by file path for efficient lookup.
   */
  async getBatch(folderId: string, filePaths: string[]): Promise<Map<string, TokenCacheEntry>> {
    if (filePaths.length === 0) {
      return new Map();
    }
    const validatedPaths = filePaths.map((filePath) => this.validateFilePath(filePath));

    // Build parameterized query with placeholder array
    const placeholders = validatedPaths.map((_, i) => `$${i + 2}`).join(',');
    const result = await this.db.query<TokenCacheRow>(
      `SELECT * FROM file_token_cache
       WHERE folder_id = $1 AND file_path IN (${placeholders})`,
      [folderId, ...validatedPaths]
    );

    const map = new Map<string, TokenCacheEntry>();
    for (const row of result.rows) {
      map.set(row.file_path, rowToEntry(row));
    }

    return map;
  }

  /**
   * Get all cached entries for a folder.
   */
  async getAllForFolder(folderId: string): Promise<TokenCacheEntry[]> {
    const result = await this.db.query<TokenCacheRow>(
      'SELECT * FROM file_token_cache WHERE folder_id = $1',
      [folderId]
    );

    return result.rows.map(rowToEntry);
  }

  /**
   * Upsert a single cache entry.
   */
  async set(entry: TokenCacheEntry): Promise<void> {
    const validatedPath = this.validateFilePath(entry.filePath);
    await this.upsertEntryWithValidatedPath(entry, validatedPath);
  }

  /**
   * Batch upsert multiple entries efficiently.
   */
  async setBatch(entries: TokenCacheEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    // Validate all paths up-front so invalid batches fail before any writes begin.
    const validatedEntries = entries.map((entry) => ({
      entry,
      validatedPath: this.validateFilePath(entry.filePath),
    }));

    // Use a transaction for atomicity
    await this.db.query('BEGIN');
    try {
      for (const { entry, validatedPath } of validatedEntries) {
        await this.upsertEntryWithValidatedPath(entry, validatedPath);
      }
      await this.db.query('COMMIT');
    } catch (error) {
      await this.db.query('ROLLBACK');
      throw error;
    }
  }

  /**
   * Delete a single cache entry.
   */
  async delete(folderId: string, filePath: string): Promise<boolean> {
    const validatedPath = this.validateFilePath(filePath);
    const result = await this.db.query(
      `DELETE FROM file_token_cache
       WHERE folder_id = $1 AND file_path = $2`,
      [folderId, validatedPath]
    );

    return (result.affectedRows ?? 0) > 0;
  }

  /**
   * Clear all cached entries for a folder.
   * Call this when a folder is removed from the workspace.
   */
  async clearFolder(folderId: string): Promise<number> {
    const result = await this.db.query('DELETE FROM file_token_cache WHERE folder_id = $1', [
      folderId,
    ]);

    return result.affectedRows ?? 0;
  }

  /**
   * Clear all cached entries.
   */
  async clearAll(): Promise<number> {
    const result = await this.db.query('DELETE FROM file_token_cache');
    return result.affectedRows ?? 0;
  }

  /**
   * Get total token count for selected files.
   * Uses SQL SUM for efficiency with large selections.
   */
  async getTotalTokens(folderId: string, filePaths: string[]): Promise<number> {
    if (filePaths.length === 0) {
      return 0;
    }
    const validatedPaths = filePaths.map((filePath) => this.validateFilePath(filePath));

    const placeholders = validatedPaths.map((_, i) => `$${i + 2}`).join(',');
    const result = await this.db.query<{ total: string }>(
      `SELECT COALESCE(SUM(token_count), 0) as total
       FROM file_token_cache
       WHERE folder_id = $1 AND file_path IN (${placeholders})`,
      [folderId, ...validatedPaths]
    );

    return Number(result.rows[0]?.total ?? 0);
  }

  /**
   * Get cache statistics.
   */
  async getStats(folderId?: string): Promise<TokenCacheStats> {
    const whereClause = folderId ? 'WHERE folder_id = $1' : '';
    const params = folderId ? [folderId] : [];

    const result = await this.db.query<{
      entry_count: string;
      total_tokens: string;
      accurate_count: string;
      heuristic_count: string;
    }>(
      `SELECT
         COUNT(*) as entry_count,
         COALESCE(SUM(token_count), 0) as total_tokens,
         COUNT(*) FILTER (WHERE counting_mode = 'accurate') as accurate_count,
         COUNT(*) FILTER (WHERE counting_mode = 'heuristic') as heuristic_count
       FROM file_token_cache
       ${whereClause}`,
      params
    );

    const row = result.rows[0];
    return {
      entryCount: Number(row?.entry_count ?? 0),
      totalTokens: Number(row?.total_tokens ?? 0),
      accurateCount: Number(row?.accurate_count ?? 0),
      heuristicCount: Number(row?.heuristic_count ?? 0),
    };
  }

  /**
   * Find entries with stale counting mode.
   * Useful when user changes from heuristic to accurate mode.
   */
  async findByCountingMode(
    folderId: string,
    mode: TokenCountingMode,
    limit = 100
  ): Promise<TokenCacheEntry[]> {
    const result = await this.db.query<TokenCacheRow>(
      `SELECT * FROM file_token_cache
       WHERE folder_id = $1 AND counting_mode = $2
       LIMIT $3`,
      [folderId, mode, limit]
    );

    return result.rows.map(rowToEntry);
  }

  /**
   * Vacuum the table to reclaim space after bulk deletes.
   */
  async vacuum(): Promise<void> {
    // PGlite doesn't support VACUUM in the same way, but we can optimize
    // by running ANALYZE to update statistics
    await this.db.query('ANALYZE file_token_cache');
  }
}
