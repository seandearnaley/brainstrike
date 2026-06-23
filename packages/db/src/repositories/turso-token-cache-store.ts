import { validateRelativeFilePath } from '@brainstrike/utils';
import type {
  BrainstrikeDbExecutionClient,
  BrainstrikeDbTransactionClient,
} from '../architecture/brainstrike-db-client-contract.js';
import type {
  TokenCacheEntry,
  TokenCacheStats,
  TokenCountingMode,
} from './token-cache-store-types.js';

const TOKEN_CACHE_FILE_PATH_LABEL = 'Token cache file path';
const ISO_UTC_TEXT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_SQLITE_IN_LIST_PARAMS = 900;
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

interface TursoTokenCacheRow {
  readonly content_hash: string;
  readonly counting_mode: TokenCountingMode;
  readonly created_at: string;
  readonly file_path: string;
  readonly file_size: number;
  readonly folder_id: string;
  readonly model_encoding: string | null;
  readonly mtime_ms: number | null;
  readonly token_count: number;
  readonly updated_at: string;
}

interface TursoTokenCacheStatsRow {
  readonly accurate_count: number;
  readonly entry_count: number;
  readonly heuristic_count: number;
  readonly total_tokens: number;
}

export class TursoTokenCacheStore {
  constructor(private readonly db: BrainstrikeDbExecutionClient) {}

  async get(folderId: string, filePath: string): Promise<TokenCacheEntry | null> {
    const validatedPath = this.validateFilePath(filePath);
    const result = await this.db.query<TursoTokenCacheRow>(
      `SELECT folder_id, file_path, content_hash, file_size, mtime_ms, token_count, counting_mode, model_encoding, created_at, updated_at
       FROM file_token_cache
       WHERE folder_id = ? AND file_path = ?`,
      [folderId, validatedPath]
    );

    const row = result.rows[0];
    return row ? fromRow(row) : null;
  }

  async getBatch(
    folderId: string,
    filePaths: readonly string[]
  ): Promise<Map<string, TokenCacheEntry>> {
    if (filePaths.length === 0) {
      return new Map();
    }
    const validatedPaths = uniqueStrings(
      filePaths.map((filePath) => this.validateFilePath(filePath))
    );

    const entries = new Map<string, TokenCacheEntry>();
    for (const pathChunk of chunkArray(validatedPaths, MAX_SQLITE_IN_LIST_PARAMS)) {
      const result = await this.db.query<TursoTokenCacheRow>(
        `SELECT folder_id, file_path, content_hash, file_size, mtime_ms, token_count, counting_mode, model_encoding, created_at, updated_at
         FROM file_token_cache
         WHERE folder_id = ? AND file_path IN (${createPlaceholders(pathChunk.length)})
         ORDER BY file_path ASC`,
        [folderId, ...pathChunk]
      );
      for (const row of result.rows) {
        entries.set(row.file_path, fromRow(row));
      }
    }
    return entries;
  }

  async getAllForFolder(folderId: string): Promise<TokenCacheEntry[]> {
    const result = await this.db.query<TursoTokenCacheRow>(
      `SELECT folder_id, file_path, content_hash, file_size, mtime_ms, token_count, counting_mode, model_encoding, created_at, updated_at
       FROM file_token_cache
       WHERE folder_id = ?
       ORDER BY file_path ASC`,
      [folderId]
    );

    return result.rows.map(fromRow);
  }

  async set(entry: TokenCacheEntry): Promise<void> {
    const validatedPath = this.validateFilePath(entry.filePath);
    await upsertTokenCacheEntry(this.db, entry, validatedPath);
  }

  async setBatch(entries: readonly TokenCacheEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const validatedEntries = entries.map((entry) => ({
      entry,
      validatedPath: this.validateFilePath(entry.filePath),
    }));

    await this.db.transaction(async (tx) => {
      for (const { entry, validatedPath } of validatedEntries) {
        await upsertTokenCacheEntry(tx, entry, validatedPath);
      }
    });
  }

  async delete(folderId: string, filePath: string): Promise<boolean> {
    const validatedPath = this.validateFilePath(filePath);
    const result = await this.db.query<{ file_path: string }>(
      'DELETE FROM file_token_cache WHERE folder_id = ? AND file_path = ? RETURNING file_path',
      [folderId, validatedPath]
    );
    return result.rows.length > 0;
  }

  async clearFolder(folderId: string): Promise<number> {
    const result = await this.db.query<{ file_path: string }>(
      'DELETE FROM file_token_cache WHERE folder_id = ? RETURNING file_path',
      [folderId]
    );
    return result.rows.length;
  }

  async clearAll(): Promise<number> {
    const result = await this.db.query<{ file_path: string }>(
      'DELETE FROM file_token_cache RETURNING file_path'
    );
    return result.rows.length;
  }

  async getTotalTokens(folderId: string, filePaths: readonly string[]): Promise<number> {
    if (filePaths.length === 0) {
      return 0;
    }
    const validatedPaths = uniqueStrings(
      filePaths.map((filePath) => this.validateFilePath(filePath))
    );
    let totalTokens = 0;
    for (const pathChunk of chunkArray(validatedPaths, MAX_SQLITE_IN_LIST_PARAMS)) {
      const result = await this.db.query<{ total_tokens: number }>(
        `SELECT COALESCE(SUM(token_count), 0) AS total_tokens
         FROM file_token_cache
         WHERE folder_id = ? AND file_path IN (${createPlaceholders(pathChunk.length)})`,
        [folderId, ...pathChunk]
      );
      totalTokens += Number(result.rows[0]?.total_tokens ?? 0);
    }
    return totalTokens;
  }

  async getStats(folderId?: string): Promise<TokenCacheStats> {
    const whereSql = folderId ? 'WHERE folder_id = ?' : '';
    const params = folderId ? [folderId] : [];
    const result = await this.db.query<TursoTokenCacheStatsRow>(
      `SELECT
        COUNT(*) AS entry_count,
        COALESCE(SUM(token_count), 0) AS total_tokens,
        SUM(CASE WHEN counting_mode = 'accurate' THEN 1 ELSE 0 END) AS accurate_count,
        SUM(CASE WHEN counting_mode = 'heuristic' THEN 1 ELSE 0 END) AS heuristic_count
       FROM file_token_cache
       ${whereSql}`,
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

  async findByCountingMode(
    folderId: string,
    mode: TokenCountingMode,
    limit = 100
  ): Promise<TokenCacheEntry[]> {
    const result = await this.db.query<TursoTokenCacheRow>(
      `SELECT folder_id, file_path, content_hash, file_size, mtime_ms, token_count, counting_mode, model_encoding, created_at, updated_at
       FROM file_token_cache
       WHERE folder_id = ? AND counting_mode = ?
       ORDER BY file_path ASC
       LIMIT ?`,
      [folderId, mode, limit]
    );

    return result.rows.map(fromRow);
  }

  async vacuum(): Promise<void> {
    await this.db.exec('ANALYZE file_token_cache');
  }

  private validateFilePath(filePath: string): string {
    return validateRelativeFilePath(filePath, { label: TOKEN_CACHE_FILE_PATH_LABEL });
  }
}

async function upsertTokenCacheEntry(
  db: BrainstrikeDbTransactionClient,
  entry: TokenCacheEntry,
  validatedPath: string
): Promise<void> {
  await db.exec(
    `INSERT INTO file_token_cache (
      folder_id, file_path, content_hash, file_size, mtime_ms, token_count, counting_mode, model_encoding
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(folder_id, file_path) DO UPDATE SET
      content_hash = excluded.content_hash,
      file_size = excluded.file_size,
      mtime_ms = excluded.mtime_ms,
      token_count = excluded.token_count,
      counting_mode = excluded.counting_mode,
      model_encoding = excluded.model_encoding,
      updated_at = ${NOW_SQL}`,
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

function fromRow(row: TursoTokenCacheRow): TokenCacheEntry {
  return {
    contentHash: row.content_hash,
    countingMode: row.counting_mode,
    createdAt: assertIsoUtcTextTimestamp(row.created_at),
    filePath: row.file_path,
    fileSize: Number(row.file_size),
    folderId: row.folder_id,
    modelEncoding: row.model_encoding,
    mtimeMs: row.mtime_ms === null ? null : Number(row.mtime_ms),
    tokenCount: Number(row.token_count),
    updatedAt: assertIsoUtcTextTimestamp(row.updated_at),
  };
}

function assertIsoUtcTextTimestamp(value: string): string {
  if (!ISO_UTC_TEXT_TIMESTAMP.test(value)) {
    throw new Error(`Turso token cache timestamp has invalid stored value "${value}".`);
  }
  return value;
}

function createPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function chunkArray<TValue>(
  values: readonly TValue[],
  chunkSize: number
): readonly (readonly TValue[])[] {
  const chunks: TValue[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}
