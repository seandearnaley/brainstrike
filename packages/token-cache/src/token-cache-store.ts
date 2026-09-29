/**
 * Token Cache Store
 *
 * PGlite-backed persistent storage for token counts.
 * Provides efficient batch queries and aggregations.
 */

import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { createLogger } from '@brainstrike/logging';
import { validateRelativeFilePath } from '@brainstrike/utils';
import type { PGlite } from '@electric-sql/pglite';
import { Duration, Effect, Schedule } from 'effect';
import type {
  TokenCacheEntry,
  TokenCacheLookupTelemetryRecord,
  TokenCacheStats,
  TokenCacheStoreOptions,
  TokenCacheStoreTelemetry,
  TokenCountingMode,
} from './types';

const logger = createLogger('TokenCacheStore');
const TOKEN_CACHE_FILE_PATH_LABEL = 'Token cache file path';
const DEFAULT_TRANSACTION_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_TRANSACTION_RETRY_BASE_DELAY_MS = 25;
const MAX_NATIVE_TIMER_DELAY_MS = 2_147_483_647;
const TRANSIENT_TRANSACTION_ERROR_CODES = new Set([
  '40001',
  '40P01',
  '55P03',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
]);
const TRANSIENT_TRANSACTION_MESSAGE_PATTERNS = [
  'could not serialize',
  'database is busy',
  'database is locked',
  'deadlock detected',
  'io error',
  'lock timeout',
  'temporarily unavailable',
  'transaction conflict',
];

/**
 * Database row type (snake_case from SQL)
 */
interface TokenCacheRow {
  content_hash: string;
  counting_mode: string;
  created_at: string;
  file_path: string;
  file_size: string; // BIGINT comes as string
  folder_id: string;
  id: number;
  model_encoding: string | null;
  mtime_ms: string | null;
  token_count: number;
  updated_at: string;
}

interface ValidatedTokenCacheEntry {
  readonly entry: TokenCacheEntry;
  readonly validatedPath: string;
}

function resolvePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function getErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' && code.trim().length > 0 ? code : null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTransientTransactionError(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code && TRANSIENT_TRANSACTION_ERROR_CODES.has(code)) {
    return true;
  }

  const message = getErrorMessage(error).toLowerCase();
  return TRANSIENT_TRANSACTION_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * Convert database row to TokenCacheEntry
 */
function rowToEntry(row: TokenCacheRow): TokenCacheEntry {
  return {
    contentHash: row.content_hash,
    countingMode: row.counting_mode as TokenCountingMode,
    createdAt: row.created_at,
    filePath: row.file_path,
    fileSize: Number(row.file_size),
    folderId: row.folder_id,
    modelEncoding: row.model_encoding,
    mtimeMs: row.mtime_ms ? Number(row.mtime_ms) : null,
    tokenCount: row.token_count,
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
  private telemetryClockUnavailable = false;
  private readonly transactionRetryBaseDelayMs: number;
  private readonly transactionRetryMaxAttempts: number;
  private readonly telemetry: TokenCacheStoreTelemetry | null;

  constructor(db: PGlite, options: TokenCacheStoreOptions = {}) {
    this.db = db;
    this.transactionRetryBaseDelayMs = resolvePositiveInteger(
      options.transactionRetryBaseDelayMs,
      DEFAULT_TRANSACTION_RETRY_BASE_DELAY_MS
    );
    this.transactionRetryMaxAttempts = resolvePositiveInteger(
      options.transactionRetryMaxAttempts,
      DEFAULT_TRANSACTION_RETRY_MAX_ATTEMPTS
    );
    if (
      this.transactionRetryMaxAttempts > 1 &&
      this.transactionRetryBaseDelayMs * 2 ** (this.transactionRetryMaxAttempts - 2) >
        MAX_NATIVE_TIMER_DELAY_MS
    ) {
      throw new RangeError('Token cache transaction retry delay exceeds the native timer range');
    }
    this.telemetry = options.telemetry ?? null;
  }

  private recordLookupTelemetry(record: TokenCacheLookupTelemetryRecord): void {
    if (!this.telemetry) {
      return;
    }
    try {
      this.telemetry.recordLookup(record);
    } catch (error) {
      logger.error('Token cache lookup telemetry recording failed', {
        error: getErrorMessage(error),
      });
    }
  }

  private readLookupTelemetryClock(): number | null {
    if (this.telemetryClockUnavailable) {
      return null;
    }
    try {
      if (typeof performance === 'undefined' || typeof performance.now !== 'function') {
        throw new Error('Token cache telemetry requires the Performance monotonic clock');
      }
      const timestamp = performance.now();
      if (!Number.isFinite(timestamp)) {
        throw new Error('Token cache telemetry Performance clock returned a non-finite value');
      }
      return timestamp;
    } catch (error) {
      this.telemetryClockUnavailable = true;
      logger.error('Token cache telemetry timing unavailable; lookup will continue', {
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  private recordTimedLookup(
    startedAt: number | null,
    record: Omit<TokenCacheLookupTelemetryRecord, 'durationMs'>
  ): void {
    if (startedAt === null) {
      return;
    }
    const completedAt = this.readLookupTelemetryClock();
    if (completedAt === null) {
      return;
    }
    this.recordLookupTelemetry({ ...record, durationMs: completedAt - startedAt });
  }

  private async measureLookup<T>(
    work: () => Promise<T>,
    summarize: (result: T) => { readonly hitCount: number; readonly lookupCount: number },
    failureCounts: { readonly hitCount: number; readonly lookupCount: number }
  ): Promise<T> {
    const startedAt = this.readLookupTelemetryClock();
    try {
      const result = await work();
      this.recordTimedLookup(startedAt, summarize(result));
      return result;
    } catch (error) {
      this.recordTimedLookup(startedAt, { ...failureCounts, failed: true });
      throw error;
    }
  }

  private validateFilePath(filePath: string): string {
    try {
      const validatedPath = validateRelativeFilePath(filePath, {
        label: TOKEN_CACHE_FILE_PATH_LABEL,
      });
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
    const result = await this.measureLookup(
      async () =>
        await this.db.query<TokenCacheRow>(
          `SELECT * FROM file_token_cache
         WHERE folder_id = $1 AND file_path = $2`,
          [folderId, validatedPath]
        ),
      (queryResult) => ({ hitCount: queryResult.rows[0] ? 1 : 0, lookupCount: 1 }),
      { hitCount: 0, lookupCount: 1 }
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
    return await this.measureLookup(
      async () => {
        const result = await this.db.query<TokenCacheRow>(
          `SELECT * FROM file_token_cache
           WHERE folder_id = $1 AND file_path IN (${placeholders})`,
          [folderId, ...validatedPaths]
        );
        const entries = new Map<string, TokenCacheEntry>();
        for (const row of result.rows) {
          entries.set(row.file_path, rowToEntry(row));
        }
        return entries;
      },
      (entries) => ({
        hitCount: validatedPaths.reduce(
          (count, validatedPath) => count + (entries.has(validatedPath) ? 1 : 0),
          0
        ),
        lookupCount: validatedPaths.length,
      }),
      { hitCount: 0, lookupCount: validatedPaths.length }
    );
  }

  /**
   * Get all cached entries for a folder.
   */
  async getAllForFolder(folderId: string): Promise<TokenCacheEntry[]> {
    return await this.measureLookup(
      async () => {
        const result = await this.db.query<TokenCacheRow>(
          'SELECT * FROM file_token_cache WHERE folder_id = $1',
          [folderId]
        );
        return result.rows.map(rowToEntry);
      },
      () => ({ hitCount: 0, lookupCount: 0 }),
      { hitCount: 0, lookupCount: 0 }
    );
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
    const validatedEntries: ValidatedTokenCacheEntry[] = entries.map((entry) => ({
      entry,
      validatedPath: this.validateFilePath(entry.filePath),
    }));

    await this.runBatchTransactionWithRetry(validatedEntries);
  }

  private async runBatchTransaction(entries: readonly ValidatedTokenCacheEntry[]): Promise<void> {
    await this.db.query('BEGIN');
    try {
      for (const { entry, validatedPath } of entries) {
        await this.upsertEntryWithValidatedPath(entry, validatedPath);
      }
      await this.db.query('COMMIT');
    } catch (error) {
      await this.db.query('ROLLBACK').catch((rollbackError: unknown) => {
        logger.warn('Token cache batch transaction rollback failed', {
          originalReason: getErrorMessage(error),
          rollbackReason: getErrorMessage(rollbackError),
        });
      });
      throw error;
    }
  }

  private async runBatchTransactionWithRetry(
    entries: readonly ValidatedTokenCacheEntry[]
  ): Promise<void> {
    const exponential: Schedule.Schedule<Duration.Duration, { readonly original: unknown }> =
      Schedule.exponential(this.transactionRetryBaseDelayMs);
    const retrySchedule = exponential.pipe(
      Schedule.upTo({ times: this.transactionRetryMaxAttempts - 1 }),
      Schedule.while(({ input }) => isTransientTransactionError(input.original)),
      Schedule.tap(({ attempt, duration, input }) =>
        Effect.sync(() => {
          const retryDelayMs = Duration.toMillis(duration);
          logger.warn('Retrying token cache batch transaction after transient failure', {
            attempt,
            code: getErrorCode(input.original),
            delayMs: retryDelayMs,
            maxAttempts: this.transactionRetryMaxAttempts,
            reason: getErrorMessage(input.original),
          });
        })
      )
    );
    await runAtPromiseBoundary(
      Effect.retry(
        Effect.tryPromise({
          catch: (original) => ({ original }),
          try: () => this.runBatchTransaction(entries),
        }),
        retrySchedule
      ).pipe(Effect.mapError(({ original }) => original))
    );
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
    return await this.measureLookup(
      async () => {
        const result = await this.db.query<{ total: string }>(
          `SELECT COALESCE(SUM(token_count), 0) as total
           FROM file_token_cache
           WHERE folder_id = $1 AND file_path IN (${placeholders})`,
          [folderId, ...validatedPaths]
        );
        return Number(result.rows[0]?.total ?? 0);
      },
      () => ({ hitCount: 0, lookupCount: 0 }),
      { hitCount: 0, lookupCount: 0 }
    );
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
      accurateCount: Number(row?.accurate_count ?? 0),
      entryCount: Number(row?.entry_count ?? 0),
      heuristicCount: Number(row?.heuristic_count ?? 0),
      totalTokens: Number(row?.total_tokens ?? 0),
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
