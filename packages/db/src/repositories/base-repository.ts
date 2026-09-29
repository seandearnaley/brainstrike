import { createLogger } from '@brainstrike/logging';
import { generateContentHash, generateUUID } from '@brainstrike/utils';
import { measureDatabaseQuery } from '../database-query-telemetry.js';
import type {
  FileImportRequest,
  FileImportResult,
  FileRecord,
  FileRecordUpdate,
  ManagedCacheEntryMetadata,
} from '../models/file-record.js';
import {
  assertTextContentHasNoNullBytes,
  assertTextContentsHaveNoNullBytes,
} from '../text-content-invariants.js';
import type { IDatabase, IFileRecordRepository } from './interfaces.js';

const logger = createLogger('DB:FileRecordRepository');
const BULK_IMPORT_INFO_LOG_THRESHOLD = 100;
// 3 parameters per row; stays far below the 65,535 Postgres parameter limit.
const STAT_METADATA_UPDATE_BATCH_SIZE = 5000;

type FileRecordDatabase = Omit<IDatabase, 'query'> & {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
};

/**
 * Filter-not-throw (BST-1027 review): file_records reads SKIP malformed rows,
 * matching the pre-convergence behavior, the four sibling accessors in this
 * class (findById/findByContentHash/count*), and the repo-wide convention
 * pinned by 'ignores malformed rows instead of throwing' tests elsewhere.
 */
function isFileRecordRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce a stat column (size INTEGER, mtime_ms BIGINT) from a raw row to a finite
 * number, or null when absent/invalid. PGlite can surface a BIGINT column as a
 * string or bigint depending on the driver path, so all three are handled.
 */
function parseOptionalStatNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Allowed fields for updates - prevents accidental ID updates
 */
const ALLOWED_UPDATE_FIELDS: readonly (keyof FileRecord)[] = [
  'name',
  'path',
  'size',
  'createdAt',
  'updatedAt',
  'content',
  'contentHash',
  'tokenCount',
  'processedAt',
  'embedding',
  'embeddingSetId',
  'chunksProcessedAt',
  'chunksCount',
  'chunkingStrategy',
] as const;

/**
 * Base repository with shared SQL generation and mapping logic
 */
export abstract class BaseFileRecordRepository implements IFileRecordRepository {
  protected readonly tableName = 'file_records';

  constructor(protected db: FileRecordDatabase) {}

  async create(record: FileRecord): Promise<void> {
    const fields = ['id', 'name', 'path', 'size', 'created_at', 'updated_at'];
    const values: unknown[] = [
      record.id,
      record.name,
      record.path,
      record.size,
      record.createdAt,
      record.updatedAt,
    ];

    // Add embedding_set_id if present
    if (record.embeddingSetId) {
      fields.push('embedding_set_id');
      values.push(record.embeddingSetId);
    }

    if (record.tokenCount !== undefined) {
      fields.push('token_count');
      values.push(record.tokenCount);
    }

    if (record.chunksCount !== undefined) {
      fields.push('chunks_count');
      values.push(record.chunksCount);
    }

    if (record.chunkingStrategy !== undefined) {
      fields.push('chunking_strategy');
      values.push(record.chunkingStrategy);
    }

    const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `INSERT INTO ${this.tableName} (${fields.join(', ')}) VALUES (${placeholders})`;

    await this.db.query(sql, values);
  }

  async createWithContent(record: FileRecord): Promise<void> {
    assertTextContentHasNoNullBytes(record.content, 'File record content');
    const fields = [
      'id',
      'name',
      'path',
      'size',
      'created_at',
      'updated_at',
      'content',
      'content_hash',
      'token_count',
      'processed_at',
    ];
    const values: unknown[] = [
      record.id,
      record.name,
      record.path,
      record.size,
      record.createdAt,
      record.updatedAt,
      record.content ?? null,
      record.contentHash || null,
      record.tokenCount || 0,
      record.processedAt || null,
    ];

    // Add embedding_set_id if present
    if (record.embeddingSetId) {
      fields.push('embedding_set_id');
      values.push(record.embeddingSetId);
    }

    const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `INSERT INTO ${this.tableName} (${fields.join(', ')}) VALUES (${placeholders})`;

    await this.db.query(sql, values);
  }

  async findById(id: string): Promise<FileRecord | null> {
    return await measureDatabaseQuery('file-tree', async () => {
      const sql = `SELECT * FROM ${this.tableName} WHERE id = $1`;
      const result = await this.db.query(sql, [id]);
      const row = result.rows[0];

      if (!row || typeof row !== 'object' || row === null) {
        return null;
      }

      return this.fromRow(row as Record<string, unknown>);
    });
  }

  async findByIds(ids: readonly string[]): Promise<FileRecord[]> {
    if (ids.length === 0) {
      return [];
    }

    return await measureDatabaseQuery('file-tree', async () => {
      const uniqueIds = Array.from(new Set(ids));
      // file_records.id is persisted as TEXT in existing migrations; cast both sides to text
      // to keep lookup behavior stable across legacy/electron databases.
      const sql = `SELECT * FROM ${this.tableName} WHERE id::text = ANY($1::text[])`;
      const result = await this.db.query(sql, [uniqueIds]);

      if (!Array.isArray(result.rows)) {
        return [];
      }

      return result.rows.filter(isFileRecordRow).map((row) => this.fromRow(row));
    });
  }

  async findByContentHash(contentHash: string): Promise<FileRecord | null> {
    return await measureDatabaseQuery('file-tree', async () => {
      const sql = `SELECT * FROM ${this.tableName} WHERE content_hash = $1`;
      const result = await this.db.query(sql, [contentHash]);
      const row = result.rows[0];

      if (!row || typeof row !== 'object' || row === null) {
        return null;
      }

      return this.fromRow(row as Record<string, unknown>);
    });
  }

  async findAll(): Promise<FileRecord[]> {
    return await measureDatabaseQuery('file-tree', async () => {
      const sql = `SELECT * FROM ${this.tableName} ORDER BY updated_at DESC`;
      const result = await this.db.query(sql);

      if (!Array.isArray(result.rows)) {
        return [];
      }

      return result.rows.filter(isFileRecordRow).map((row) => this.fromRow(row));
    });
  }

  async findAllWithContent(): Promise<FileRecord[]> {
    return await measureDatabaseQuery('file-tree', async () => {
      const sql = `SELECT * FROM ${this.tableName} WHERE content IS NOT NULL ORDER BY processed_at DESC, updated_at DESC`;
      const result = await this.db.query(sql);

      if (!Array.isArray(result.rows)) {
        return [];
      }

      return result.rows.filter(isFileRecordRow).map((row) => this.fromRow(row));
    });
  }

  async findByManagedCacheIdentity(
    embeddingSetId: string,
    rootId: string,
    relativePath: string
  ): Promise<FileRecord | null> {
    return await measureDatabaseQuery('file-tree', async () => {
      const sql = `SELECT * FROM ${this.tableName} WHERE embedding_set_id = $1 AND root_id = $2 AND path = $3 ORDER BY updated_at DESC LIMIT 1`;
      const result = await this.db.query(sql, [embeddingSetId, rootId, relativePath]);
      const row = result.rows[0];

      if (!isFileRecordRow(row)) {
        return null;
      }

      return this.fromRow(row);
    });
  }

  async listManagedCacheEntries(embeddingSetId: string): Promise<FileRecord[]> {
    return await measureDatabaseQuery('file-tree', async () => {
      const sql = `SELECT * FROM ${this.tableName} WHERE embedding_set_id = $1 AND root_id IS NOT NULL ORDER BY updated_at DESC`;
      const result = await this.db.query(sql, [embeddingSetId]);

      if (!Array.isArray(result.rows)) {
        return [];
      }

      return result.rows.filter(isFileRecordRow).map((row) => this.fromRow(row));
    });
  }

  async listManagedCacheEntryMetadata(
    embeddingSetId: string
  ): Promise<ManagedCacheEntryMetadata[]> {
    return await measureDatabaseQuery('file-tree', async () => {
      // Managed-cache dedup identity is root_id since the source_root_path
      // retirement; rows without a root_id are not part of the managed cache.
      const sql = `SELECT id, embedding_set_id, root_id, path, content_hash, size, mtime_ms, chunks_count, chunks_processed_at, updated_at FROM ${this.tableName} WHERE embedding_set_id = $1 AND root_id IS NOT NULL ORDER BY updated_at DESC`;
      const result = await this.db.query(sql, [embeddingSetId]);

      if (!Array.isArray(result.rows)) {
        return [];
      }

      return result.rows.filter(isFileRecordRow).flatMap((row) => {
        const fileRecordId = row['id'];
        const rowEmbeddingSetId = row['embedding_set_id'];
        const rootId = row['root_id'];
        const relativePath = row['path'];
        const contentHash = row['content_hash'];
        const updatedAt = row['updated_at'];
        if (
          typeof fileRecordId !== 'string' ||
          typeof rowEmbeddingSetId !== 'string' ||
          typeof rootId !== 'string' ||
          typeof relativePath !== 'string' ||
          !(typeof contentHash === 'string' || contentHash === null) ||
          !(updatedAt instanceof Date || typeof updatedAt === 'string')
        ) {
          return [];
        }
        const parsedSize = parseOptionalStatNumber(row['size']);
        return [
          {
            contentHash: contentHash ?? '',
            embeddingSetId: rowEmbeddingSetId,
            fileRecordId,
            relativePath,
            rootId,
            ...(typeof parsedSize === 'number' ? { size: parsedSize } : {}),
            chunksCount: parseOptionalStatNumber(row['chunks_count']),
            chunksProcessedAt:
              row['chunks_processed_at'] instanceof Date
                ? row['chunks_processed_at'].toISOString()
                : typeof row['chunks_processed_at'] === 'string'
                  ? row['chunks_processed_at']
                  : null,
            mtimeMs: parseOptionalStatNumber(row['mtime_ms']),
            updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt,
          } satisfies ManagedCacheEntryMetadata,
        ];
      });
    });
  }

  async update(id: string, updates: FileRecordUpdate): Promise<void> {
    assertTextContentHasNoNullBytes(updates.content, 'File record content');
    const fields = ALLOWED_UPDATE_FIELDS.filter((field) => Object.hasOwn(updates, field));

    if (fields.length === 0) {
      return;
    }

    const updatesObj = updates as Record<string, unknown>;
    const values = fields.map((f) => updatesObj[f]);
    values.push(id);

    const setClause = fields.map((f, i) => `${this.toDbField(f)} = $${i + 1}`).join(', ');

    const sql = `UPDATE ${this.tableName} SET ${setClause} WHERE id = $${fields.length + 1}`;
    await this.db.query(sql, values);
  }

  /**
   * Batch-stamp filesystem stat metadata (size + floored mtime) WITHOUT
   * rewriting content. This is how rows written before migration 037 (NULL
   * mtime_ms) join the stat-cache fast-path: a hash-confirmed-unchanged file
   * never goes through the import/replace write path, so without this stamp it
   * would be re-read + re-hashed on every sync indefinitely.
   */
  async updateStatMetadata(
    entries: ReadonlyArray<{ fileRecordId: string; mtimeMs: number; size: number }>
  ): Promise<void> {
    for (let offset = 0; offset < entries.length; offset += STAT_METADATA_UPDATE_BATCH_SIZE) {
      const batch = entries.slice(offset, offset + STAT_METADATA_UPDATE_BATCH_SIZE);
      const ids = batch.map((entry) => entry.fileRecordId);
      // Floor defensively: stat.mtimeMs is fractional and mtime_ms is BIGINT.
      const mtimes = batch.map((entry) => Math.floor(entry.mtimeMs));
      const sizes = batch.map((entry) => Math.floor(entry.size));
      const sql = `UPDATE ${this.tableName} AS fr
         SET mtime_ms = t.mtime_ms,
             size = t.size
        FROM unnest($1::text[], $2::bigint[], $3::integer[]) AS t(id, mtime_ms, size)
        -- Text-form comparison matches the managed-cache batch path until the
        -- legacy text-id surfaces are retired.
       WHERE fr.id::text = t.id`;
      await this.db.query(sql, [ids, mtimes, sizes]);
    }
  }

  async updateContent(
    id: string,
    content: string,
    contentHash: string,
    tokenCount: number
  ): Promise<void> {
    assertTextContentHasNoNullBytes(content, 'File record content');
    const now = new Date().toISOString();
    const sql = `UPDATE ${this.tableName} SET content = $1, content_hash = $2, token_count = $3, processed_at = $4, updated_at = $5 WHERE id = $6`;
    await this.db.query(sql, [content, contentHash, tokenCount, now, now, id]);
  }

  async delete(id: string): Promise<void> {
    const sql = `DELETE FROM ${this.tableName} WHERE id = $1`;
    await this.db.query(sql, [id]);
  }

  async count(): Promise<number> {
    return await measureDatabaseQuery('file-tree', async () => {
      const sql = `SELECT COUNT(*) as count FROM ${this.tableName}`;
      const result = await this.db.query(sql);
      const row = result.rows[0];

      if (!row || typeof row !== 'object') {
        return 0;
      }

      const countRow = row as Record<string, unknown>;
      return Number(countRow['count'] || 0);
    });
  }

  async countWithContent(): Promise<number> {
    return await measureDatabaseQuery('file-tree', async () => {
      const sql = `SELECT COUNT(*) as count FROM ${this.tableName} WHERE content IS NOT NULL`;
      const result = await this.db.query(sql);
      const row = result.rows[0];

      if (!row || typeof row !== 'object') {
        return 0;
      }

      const countRow = row as Record<string, unknown>;
      return Number(countRow['count'] || 0);
    });
  }

  async bulkImport(
    requests: FileImportRequest[],
    onProgress?: (completed: number, total: number, current?: string) => void
  ): Promise<FileImportResult[]> {
    const BATCH_SIZE = 100;
    const startTime = Date.now();
    const logBulkImportInfo = requests.length >= BULK_IMPORT_INFO_LOG_THRESHOLD;
    const logBulkImport = logBulkImportInfo ? logger.info.bind(logger) : logger.debug.bind(logger);

    logBulkImport('Starting bulk import', {
      batchSize: BATCH_SIZE,
      totalFiles: requests.length,
    });

    const results: FileImportResult[] = [];

    // Process in batches to reduce database round-trips
    for (let batchStart = 0; batchStart < requests.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, requests.length);
      const batch = requests.slice(batchStart, batchEnd);

      logger.debug(`Processing batch ${Math.floor(batchStart / BATCH_SIZE) + 1}`, {
        batchEnd,
        batchSize: batch.length,
        batchStart,
      });

      // Use transaction for atomicity within each batch (if supported)
      try {
        const batchResults = this.db.transaction
          ? await this.db.transaction(
              async (tx: IDatabase) =>
                await this.processBatch(batch, tx, onProgress, batchStart, requests.length)
            )
          : await this.processBatch(batch, this.db, onProgress, batchStart, requests.length);

        results.push(...batchResults);
      } catch (error) {
        logger.error('Batch processing failed, marking all files in batch as errors', {
          batchEnd,
          batchStart,
          error: error instanceof Error ? error.message : String(error),
        });

        // Mark all files in failed batch as errors
        for (const _request of batch) {
          results.push({
            error: `Batch failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            existed: false,
            id: '',
            imported: false,
          });
        }
      }
    }

    const duration = Date.now() - startTime;
    const successCount = results.filter((r) => r.imported || r.existed).length;
    const errorCount = results.filter((r) => r.error).length;

    logBulkImport('Bulk import complete', {
      durationMs: duration,
      errorCount,
      filesPerSecond: (requests.length / (duration / 1000)).toFixed(2),
      successCount,
      totalFiles: requests.length,
    });

    onProgress?.(requests.length, requests.length);
    return results;
  }

  private async processBatch(
    batch: FileImportRequest[],
    tx: FileRecordDatabase,
    onProgress?: (completed: number, total: number, current?: string) => void,
    offset = 0,
    total = 0
  ): Promise<FileImportResult[]> {
    const results: FileImportResult[] = [];
    assertTextContentsHaveNoNullBytes(batch, (request) => request.content, 'File record content');

    // Step 1: Pre-compute all content hashes in parallel
    const hashPromises = batch.map(async (request, index) => ({
      hash: await generateContentHash(request.content),
      index,
      request,
    }));

    const hashResults = await Promise.all(hashPromises);
    const hashes = hashResults.map((r) => r.hash);

    // Step 2: Batch query to check which files already exist (single query!)
    const existingMap = await this.findByContentHashBatch(hashes, tx);

    // Step 3: Prepare records for batch insert
    const recordsToInsert: FileRecord[] = [];
    const now = new Date().toISOString();

    for (const { index, request, hash } of hashResults) {
      onProgress?.(offset + index, total, request.name);

      const dedupeKey = this.buildDedupKey(hash, request.embeddingSetId);
      const existing = existingMap.get(dedupeKey);

      if (existing) {
        results[index] = {
          existed: true,
          id: existing.id,
          imported: false,
        };
        continue;
      }

      // Count tokens
      const tokenCount = this.countTokensHeuristic(request.content);
      const id = generateUUID();

      const record: FileRecord = {
        content: request.content,
        contentHash: hash,
        createdAt: now,
        id,
        name: request.name,
        path: request.path,
        processedAt: now,
        size: request.size,
        tokenCount,
        updatedAt: now,
      };

      // Add embedding_set_id if present on request
      if ('embeddingSetId' in request && request.embeddingSetId) {
        record.embeddingSetId = String(request.embeddingSetId);
      }

      recordsToInsert.push(record);

      if (record.contentHash) {
        const newKey = this.buildDedupKey(record.contentHash, record.embeddingSetId);
        existingMap.set(newKey, record);
      }

      results[index] = {
        existed: false,
        id,
        imported: true,
      };
    }

    // Step 4: Batch insert all new records (single query!)
    if (recordsToInsert.length > 0) {
      await this.batchInsert(recordsToInsert, tx);
      logger.debug('Batch inserted records', { count: recordsToInsert.length });
    }

    return results;
  }

  private async findByContentHashBatch(
    hashes: string[],
    tx: FileRecordDatabase
  ): Promise<Map<string, FileRecord>> {
    if (hashes.length === 0) {
      return new Map();
    }

    const placeholders = hashes.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `SELECT * FROM ${this.tableName} WHERE content_hash IN (${placeholders})`;

    const result = await tx.query(sql, hashes);
    const map = new Map<string, FileRecord>();

    for (const row of result.rows) {
      if (!isFileRecordRow(row)) {
        continue;
      }
      const record = this.fromRow(row);
      if (record.contentHash) {
        const key = this.buildDedupKey(record.contentHash, record.embeddingSetId);
        map.set(key, record);
      }
    }

    return map;
  }

  private buildDedupKey(hash: string, embeddingSetId?: string | null): string {
    const normalizedHash = hash ?? '';
    const normalizedSet = embeddingSetId?.trim() ? embeddingSetId.trim() : '__default__';
    return `${normalizedHash}::${normalizedSet}`;
  }

  private async batchInsert(records: FileRecord[], tx: FileRecordDatabase): Promise<void> {
    if (records.length === 0) {
      return;
    }

    // Check if any records have embedding_set_id
    const hasEmbeddingSetId = records.some((r) => r.embeddingSetId);

    const fields = [
      'id',
      'name',
      'path',
      'size',
      'created_at',
      'updated_at',
      'content',
      'content_hash',
      'token_count',
      'processed_at',
    ];

    if (hasEmbeddingSetId) {
      fields.push('embedding_set_id');
    }

    // Build multi-row INSERT with VALUES (row1), (row2), ...
    const valuesPerRow = fields.length;
    const rowPlaceholders: string[] = [];
    const allValues: unknown[] = [];

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record) {
        continue;
      }

      const rowValues = [
        record.id,
        record.name,
        record.path,
        record.size,
        record.createdAt,
        record.updatedAt,
        record.content,
        record.contentHash,
        record.tokenCount,
        record.processedAt,
      ];

      if (hasEmbeddingSetId) {
        rowValues.push(record.embeddingSetId);
      }

      const startParam = i * valuesPerRow + 1;
      const placeholders = rowValues.map((_, j) => `$${startParam + j}`).join(', ');
      rowPlaceholders.push(`(${placeholders})`);
      allValues.push(...rowValues);
    }

    const sql = `
      INSERT INTO ${this.tableName} (${fields.join(', ')})
      VALUES ${rowPlaceholders.join(', ')}
    `;

    await tx.query(sql, allValues);
  }

  async clearAll(): Promise<number> {
    const countResult = await measureDatabaseQuery(
      'file-tree',
      async () => await this.db.query(`SELECT COUNT(*) as count FROM ${this.tableName}`)
    );
    const countRow = countResult.rows[0];
    const totalCount =
      countRow && typeof countRow === 'object' && 'count' in countRow ? Number(countRow.count) : 0;

    await this.db.query(`DELETE FROM ${this.tableName}`);
    return totalCount;
  }

  /**
   * Simple heuristic token counting (4 chars per token)
   */
  private countTokensHeuristic(content: string): number {
    return Math.ceil(content.length / 4);
  }

  /**
   * Maps database row to domain model
   * Uses bracket notation for type safety with unknown records
   */
  protected fromRow(row: Record<string, unknown>): FileRecord {
    const record: FileRecord = {
      createdAt: String(row['created_at']),
      id: String(row['id']),
      name: String(row['name']),
      path: String(row['path']),
      size: Number(row['size']),
      updatedAt: String(row['updated_at']),
    };

    // Add optional fields if they exist (check for both null and undefined)
    if (row['content'] !== null && row['content'] !== undefined) {
      record.content = String(row['content']);
    }

    if (row['content_hash'] !== null && row['content_hash'] !== undefined) {
      record.contentHash = String(row['content_hash']);
    }

    if (row['token_count'] !== null && row['token_count'] !== undefined) {
      record.tokenCount = Number(row['token_count']);
    }

    if (row['processed_at'] !== null && row['processed_at'] !== undefined) {
      record.processedAt = String(row['processed_at']);
    }

    if (row['embedding'] !== null && row['embedding'] !== undefined) {
      record.embedding = row['embedding'] as number[];
    }

    if (row['embedding_set_id'] !== null && row['embedding_set_id'] !== undefined) {
      record.embeddingSetId = String(row['embedding_set_id']);
    }

    if (row['chunks_processed_at'] !== null && row['chunks_processed_at'] !== undefined) {
      record.chunksProcessedAt = String(row['chunks_processed_at']);
    }

    if (row['chunks_count'] !== null && row['chunks_count'] !== undefined) {
      record.chunksCount = Number(row['chunks_count']);
    }

    if (row['chunking_strategy'] !== null && row['chunking_strategy'] !== undefined) {
      record.chunkingStrategy = String(row['chunking_strategy']) as NonNullable<
        FileRecord['chunkingStrategy']
      >;
    }

    return record;
  }

  /**
   * Maps domain field names to database column names
   */
  protected toDbField(field: string): string {
    switch (field) {
      case 'createdAt':
        return 'created_at';
      case 'updatedAt':
        return 'updated_at';
      case 'contentHash':
        return 'content_hash';
      case 'tokenCount':
        return 'token_count';
      case 'processedAt':
        return 'processed_at';
      case 'embeddingSetId':
        return 'embedding_set_id';
      case 'chunksProcessedAt':
        return 'chunks_processed_at';
      case 'chunksCount':
        return 'chunks_count';
      case 'chunkingStrategy':
        return 'chunking_strategy';
      default:
        return field;
    }
  }

  /**
   * Generic query builder helpers for extended functionality
   */
  protected buildWhereClause(
    conditions: Record<string, unknown>,
    startIndex = 1
  ): { clause: string; values: unknown[] } {
    const entries = Object.entries(conditions);
    if (entries.length === 0) {
      return { clause: '', values: [] };
    }

    const clauses = entries.map(([field, _], i) => `${this.toDbField(field)} = $${startIndex + i}`);
    const values = entries.map(([_, value]) => value);

    return {
      clause: `WHERE ${clauses.join(' AND ')}`,
      values,
    };
  }
}
