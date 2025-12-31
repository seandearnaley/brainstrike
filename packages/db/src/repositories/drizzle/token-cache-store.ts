/**
 * Drizzle-based Token Cache Store
 *
 * This is the Drizzle ORM version of the TokenCacheStore.
 * Provides type-safe database operations for file token caching.
 */

import { and, count, eq, inArray, sql, sum } from 'drizzle-orm';
import type { DrizzleDb } from '../../drizzle/database.js';
import { fileTokenCache } from '../../schema/index.js';

// Helper type for execute results
type RawRow = Record<string, unknown>;

/**
 * Token counting mode
 */
export type TokenCountingMode = 'accurate' | 'heuristic';

/**
 * Token cache entry type (matches the original TokenCacheStore types)
 */
export type TokenCacheEntry = {
  folderId: string;
  filePath: string;
  contentHash: string;
  fileSize: number;
  mtimeMs: number | null;
  tokenCount: number;
  countingMode: TokenCountingMode;
  modelEncoding: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Token cache statistics
 */
export type TokenCacheStats = {
  entryCount: number;
  totalTokens: number;
  accurateCount: number;
  heuristicCount: number;
};

/**
 * DrizzleTokenCacheStore provides persistent storage for token counts using Drizzle ORM.
 *
 * Features:
 * - Efficient batch queries for multiple files
 * - SQL aggregations for total token counts
 * - Automatic upsert on conflict
 * - Folder-level cache clearing
 */
export class DrizzleTokenCacheStore {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * Get a single cached entry by folder and path.
   */
  async get(folderId: string, filePath: string): Promise<TokenCacheEntry | null> {
    const [row] = await this.db
      .select()
      .from(fileTokenCache)
      .where(and(eq(fileTokenCache.folderId, folderId), eq(fileTokenCache.filePath, filePath)));

    return row ? this.fromRow(row) : null;
  }

  /**
   * Get multiple cached entries in a single query.
   * Returns a Map keyed by file path for efficient lookup.
   */
  async getBatch(folderId: string, filePaths: string[]): Promise<Map<string, TokenCacheEntry>> {
    if (filePaths.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .select()
      .from(fileTokenCache)
      .where(
        and(eq(fileTokenCache.folderId, folderId), inArray(fileTokenCache.filePath, filePaths))
      );

    const map = new Map<string, TokenCacheEntry>();
    for (const row of rows) {
      map.set(row.filePath, this.fromRow(row));
    }

    return map;
  }

  /**
   * Get all cached entries for a folder.
   */
  async getAllForFolder(folderId: string): Promise<TokenCacheEntry[]> {
    const rows = await this.db
      .select()
      .from(fileTokenCache)
      .where(eq(fileTokenCache.folderId, folderId));

    return rows.map((row) => this.fromRow(row));
  }

  /**
   * Upsert a single cache entry.
   */
  async set(entry: TokenCacheEntry): Promise<void> {
    await this.db
      .insert(fileTokenCache)
      .values({
        folderId: entry.folderId,
        filePath: entry.filePath,
        contentHash: entry.contentHash,
        fileSize: String(entry.fileSize),
        mtimeMs: entry.mtimeMs !== null ? String(entry.mtimeMs) : null,
        tokenCount: entry.tokenCount,
        countingMode: entry.countingMode,
        modelEncoding: entry.modelEncoding,
      })
      .onConflictDoUpdate({
        target: [fileTokenCache.folderId, fileTokenCache.filePath],
        set: {
          contentHash: sql`excluded.content_hash`,
          fileSize: sql`excluded.file_size`,
          mtimeMs: sql`excluded.mtime_ms`,
          tokenCount: sql`excluded.token_count`,
          countingMode: sql`excluded.counting_mode`,
          modelEncoding: sql`excluded.model_encoding`,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        },
      });
  }

  /**
   * Batch upsert multiple entries efficiently.
   * Uses Drizzle's bulk insert for better performance than one-by-one inserts.
   */
  async setBatch(entries: TokenCacheEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    // Convert entries to insert format
    const values = entries.map((entry) => ({
      folderId: entry.folderId,
      filePath: entry.filePath,
      contentHash: entry.contentHash,
      fileSize: String(entry.fileSize),
      mtimeMs: entry.mtimeMs !== null ? String(entry.mtimeMs) : null,
      tokenCount: entry.tokenCount,
      countingMode: entry.countingMode,
      modelEncoding: entry.modelEncoding,
    }));

    // Use bulk insert with onConflictDoUpdate for efficient upsert
    // This generates a single INSERT statement with multiple VALUES
    await this.db
      .insert(fileTokenCache)
      .values(values)
      .onConflictDoUpdate({
        target: [fileTokenCache.folderId, fileTokenCache.filePath],
        set: {
          contentHash: sql`excluded.content_hash`,
          fileSize: sql`excluded.file_size`,
          mtimeMs: sql`excluded.mtime_ms`,
          tokenCount: sql`excluded.token_count`,
          countingMode: sql`excluded.counting_mode`,
          modelEncoding: sql`excluded.model_encoding`,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        },
      });
  }

  /**
   * Delete a single cache entry.
   */
  async delete(folderId: string, filePath: string): Promise<boolean> {
    const result = await this.db
      .delete(fileTokenCache)
      .where(and(eq(fileTokenCache.folderId, folderId), eq(fileTokenCache.filePath, filePath)))
      .returning();

    return result.length > 0;
  }

  /**
   * Clear all cached entries for a folder.
   * Call this when a folder is removed from the workspace.
   */
  async clearFolder(folderId: string): Promise<number> {
    const result = await this.db
      .delete(fileTokenCache)
      .where(eq(fileTokenCache.folderId, folderId))
      .returning();

    return result.length;
  }

  /**
   * Clear all cached entries.
   */
  async clearAll(): Promise<number> {
    const [countResult] = await this.db.select({ count: count() }).from(fileTokenCache);
    const total = countResult?.count ?? 0;

    await this.db.delete(fileTokenCache);
    return total;
  }

  /**
   * Get total token count for selected files.
   * Uses SQL SUM for efficiency with large selections.
   */
  async getTotalTokens(folderId: string, filePaths: string[]): Promise<number> {
    if (filePaths.length === 0) {
      return 0;
    }

    const [result] = await this.db
      .select({ total: sum(fileTokenCache.tokenCount) })
      .from(fileTokenCache)
      .where(
        and(eq(fileTokenCache.folderId, folderId), inArray(fileTokenCache.filePath, filePaths))
      );

    return Number(result?.total ?? 0);
  }

  /**
   * Get cache statistics.
   */
  async getStats(folderId?: string): Promise<TokenCacheStats> {
    // Use parameterized query to prevent SQL injection
    const baseQuery = sql`
      SELECT
        COUNT(*) as entry_count,
        COALESCE(SUM(token_count), 0) as total_tokens,
        COUNT(*) FILTER (WHERE counting_mode = 'accurate') as accurate_count,
        COUNT(*) FILTER (WHERE counting_mode = 'heuristic') as heuristic_count
      FROM file_token_cache
    `;

    const result = folderId
      ? await this.db.execute(sql`${baseQuery} WHERE folder_id = ${folderId}`)
      : await this.db.execute(baseQuery);

    const statsRows = (Array.isArray(result) ? result : result.rows) as RawRow[];
    const row = statsRows[0];
    return {
      entryCount: Number(row?.['entry_count'] ?? 0),
      totalTokens: Number(row?.['total_tokens'] ?? 0),
      accurateCount: Number(row?.['accurate_count'] ?? 0),
      heuristicCount: Number(row?.['heuristic_count'] ?? 0),
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
    const rows = await this.db
      .select()
      .from(fileTokenCache)
      .where(and(eq(fileTokenCache.folderId, folderId), eq(fileTokenCache.countingMode, mode)))
      .limit(limit);

    return rows.map((row) => this.fromRow(row));
  }

  /**
   * Vacuum the table to reclaim space after bulk deletes.
   */
  async vacuum(): Promise<void> {
    await this.db.execute(sql`ANALYZE file_token_cache`);
  }

  /**
   * Convert database row to TokenCacheEntry
   */
  private fromRow(row: typeof fileTokenCache.$inferSelect): TokenCacheEntry {
    return {
      folderId: row.folderId,
      filePath: row.filePath,
      contentHash: row.contentHash,
      fileSize: Number(row.fileSize),
      mtimeMs: row.mtimeMs ? Number(row.mtimeMs) : null,
      tokenCount: row.tokenCount,
      countingMode: row.countingMode,
      modelEncoding: row.modelEncoding,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
