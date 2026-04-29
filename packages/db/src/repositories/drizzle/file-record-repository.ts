/**
 * Drizzle-based FileRecord Repository
 *
 * This is the Drizzle ORM version of the FileRecordRepository.
 * Provides type-safe database operations for file records.
 */

import type { ResolvedChunkingStrategy } from '@brainstrike/text-splitter';
import { createLogger, generateContentHash, generateUUID } from '@brainstrike/utils';
import { count, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type {
  FileImportRequest,
  FileImportResult,
  FileRecord,
  FileRecordUpdate,
  ManagedCacheEntryMetadata,
} from '../../models/file-record.js';
import { fileRecords } from '../../schema/index.js';

type DrizzleDb = PgliteDatabase;

const logger = createLogger('DrizzleFileRecordRepository');

/**
 * Allowed fields for updates - prevents accidental ID updates
 */
const ALLOWED_UPDATE_FIELDS: readonly (keyof FileRecord)[] = [
  'name',
  'path',
  'size',
  'sourceRootPath',
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

// Field validators - extract validation logic to reduce complexity
function validateString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName}: expected string, got ${typeof value}`);
  }
  return value;
}

function validateNullableString(value: unknown, fieldName: string): string | null {
  if (value !== null && typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName}: expected string or null, got ${typeof value}`);
  }
  return value as string | null;
}

function validateSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid size: expected non-negative number, got ${value}`);
  }
  return value;
}

function validateNullableNumber(value: unknown, fieldName: string): number | null {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`Invalid ${fieldName}: expected number or null, got ${value}`);
  }
  return value as number | null;
}

function validateDateString(value: unknown, fieldName: string): Date {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName}: expected ISO string, got ${typeof value}`);
  }
  return new Date(value);
}

function validateNullableDateString(value: unknown, fieldName: string): Date | null {
  if (value !== null && value !== undefined && typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName}: expected ISO string or null, got ${typeof value}`);
  }
  return value ? new Date(value as string) : null;
}

function validateResolvedChunkingStrategy(value: unknown): ResolvedChunkingStrategy | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (
    value !== 'character' &&
    value !== 'recursive' &&
    value !== 'token' &&
    value !== 'markdown' &&
    value !== 'semantic-markdown' &&
    value !== 'html' &&
    value !== 'json' &&
    value !== 'latex' &&
    value !== 'sentence'
  ) {
    throw new Error(
      `Invalid chunkingStrategy: expected canonical resolved strategy, got ${String(value)}`
    );
  }
  return value;
}

export class DrizzleFileRecordRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(record: FileRecord): Promise<void> {
    await this.db.insert(fileRecords).values({
      id: record.id,
      name: record.name,
      path: record.path,
      size: record.size,
      sourceRootPath: record.sourceRootPath ?? null,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
      tokenCount: record.tokenCount ?? null,
      embeddingSetId: record.embeddingSetId ?? null,
      chunksCount: record.chunksCount ?? null,
      chunkingStrategy: record.chunkingStrategy ?? null,
    });
  }

  async createWithContent(record: FileRecord): Promise<void> {
    await this.db.insert(fileRecords).values({
      id: record.id,
      name: record.name,
      path: record.path,
      size: record.size,
      sourceRootPath: record.sourceRootPath ?? null,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
      content: record.content ?? null,
      contentHash: record.contentHash ?? null,
      tokenCount: record.tokenCount ?? 0,
      processedAt: record.processedAt ? new Date(record.processedAt) : null,
      embeddingSetId: record.embeddingSetId ?? null,
    });
  }

  async findById(id: string): Promise<FileRecord | null> {
    const [row] = await this.db.select().from(fileRecords).where(eq(fileRecords.id, id));

    return row ? this.fromRow(row) : null;
  }

  /**
   * Fetches multiple file records by their IDs in a single query.
   * Automatically deduplicates input IDs.
   *
   * @param ids - Array of file record IDs to fetch
   * @returns Array of found file records (may be shorter than input if some IDs don't exist)
   */
  async findByIds(ids: readonly string[]): Promise<FileRecord[]> {
    if (ids.length === 0) {
      return [];
    }

    const uniqueIds = Array.from(new Set(ids));
    const rows = await this.db.select().from(fileRecords).where(inArray(fileRecords.id, uniqueIds));

    return rows.map((row) => this.fromRow(row));
  }

  async findByContentHash(contentHash: string): Promise<FileRecord | null> {
    const [row] = await this.db
      .select()
      .from(fileRecords)
      .where(eq(fileRecords.contentHash, contentHash));

    return row ? this.fromRow(row) : null;
  }

  async findAll(): Promise<FileRecord[]> {
    const rows = await this.db
      .select()
      .from(fileRecords)
      .orderBy(sql`${fileRecords.updatedAt} DESC`);

    return rows.map((row) => this.fromRow(row));
  }

  async findAllWithContent(): Promise<FileRecord[]> {
    const rows = await this.db
      .select()
      .from(fileRecords)
      .where(isNotNull(fileRecords.content))
      .orderBy(sql`${fileRecords.processedAt} DESC, ${fileRecords.updatedAt} DESC`);

    return rows.map((row) => this.fromRow(row));
  }

  async findByManagedCacheIdentity(
    embeddingSetId: string,
    sourceRootPath: string,
    relativePath: string
  ): Promise<FileRecord | null> {
    const [row] = await this.db
      .select()
      .from(fileRecords)
      .where(
        sql`${fileRecords.embeddingSetId} = ${embeddingSetId} AND ${fileRecords.sourceRootPath} = ${sourceRootPath} AND ${fileRecords.path} = ${relativePath}`
      )
      .orderBy(sql`${fileRecords.updatedAt} DESC`)
      .limit(1);

    return row ? this.fromRow(row) : null;
  }

  async listManagedCacheEntries(embeddingSetId: string): Promise<FileRecord[]> {
    const rows = await this.db
      .select()
      .from(fileRecords)
      .where(
        sql`${fileRecords.embeddingSetId} = ${embeddingSetId} AND ${fileRecords.sourceRootPath} IS NOT NULL`
      )
      .orderBy(sql`${fileRecords.updatedAt} DESC`);

    return rows.map((row) => this.fromRow(row));
  }

  async listManagedCacheEntryMetadata(
    embeddingSetId: string
  ): Promise<ManagedCacheEntryMetadata[]> {
    const rows = await this.db
      .select({
        fileRecordId: fileRecords.id,
        embeddingSetId: fileRecords.embeddingSetId,
        sourceRootPath: fileRecords.sourceRootPath,
        relativePath: fileRecords.path,
        contentHash: fileRecords.contentHash,
        updatedAt: fileRecords.updatedAt,
      })
      .from(fileRecords)
      .where(
        sql`${fileRecords.embeddingSetId} = ${embeddingSetId} AND ${fileRecords.sourceRootPath} IS NOT NULL`
      )
      .orderBy(sql`${fileRecords.updatedAt} DESC`);

    return rows.flatMap((row) => {
      if (
        typeof row.fileRecordId !== 'string' ||
        typeof row.embeddingSetId !== 'string' ||
        typeof row.sourceRootPath !== 'string' ||
        typeof row.relativePath !== 'string' ||
        !(typeof row.contentHash === 'string' || row.contentHash === null)
      ) {
        return [];
      }
      return [
        {
          fileRecordId: row.fileRecordId,
          embeddingSetId: row.embeddingSetId,
          sourceRootPath: row.sourceRootPath,
          relativePath: row.relativePath,
          contentHash: row.contentHash ?? '',
          updatedAt: row.updatedAt.toISOString(),
        } satisfies ManagedCacheEntryMetadata,
      ];
    });
  }

  async update(id: string, updates: FileRecordUpdate): Promise<void> {
    const fields = Object.keys(updates).filter((k): k is keyof FileRecord =>
      ALLOWED_UPDATE_FIELDS.includes(k as keyof FileRecord)
    );

    if (fields.length === 0) {
      return;
    }

    const updateData = this.buildUpdateData(fields, updates);
    await this.db.update(fileRecords).set(updateData).where(eq(fileRecords.id, id));
  }

  /**
   * Build validated update data from field updates.
   * Extracted to reduce complexity of update method.
   */
  private buildUpdateData(
    fields: (keyof FileRecord)[],
    updates: FileRecordUpdate
  ): Partial<typeof fileRecords.$inferInsert> {
    const updateData: Partial<typeof fileRecords.$inferInsert> = {};

    for (const field of fields) {
      const value = updates[field];
      this.applyFieldUpdate(updateData, field, value);
    }

    return updateData;
  }

  /**
   * Apply a single field update with validation.
   * Uses extracted validators to keep complexity low.
   */
  private applyFieldUpdate(
    updateData: Partial<typeof fileRecords.$inferInsert>,
    field: keyof FileRecord,
    value: unknown
  ): void {
    switch (field) {
      case 'name':
        updateData.name = validateString(value, 'name');
        break;
      case 'path':
        updateData.path = validateString(value, 'path');
        break;
      case 'size':
        updateData.size = validateSize(value);
        break;
      case 'sourceRootPath':
        updateData.sourceRootPath = validateNullableString(value, 'sourceRootPath');
        break;
      case 'createdAt':
        updateData.createdAt = validateDateString(value, 'createdAt');
        break;
      case 'updatedAt':
        updateData.updatedAt = validateDateString(value, 'updatedAt');
        break;
      case 'content':
        updateData.content = validateNullableString(value, 'content');
        break;
      case 'contentHash':
        updateData.contentHash = validateNullableString(value, 'contentHash');
        break;
      case 'tokenCount':
        updateData.tokenCount = validateNullableNumber(value, 'tokenCount');
        break;
      case 'processedAt':
        updateData.processedAt = validateNullableDateString(value, 'processedAt');
        break;
      case 'embeddingSetId':
        updateData.embeddingSetId = validateNullableString(value, 'embeddingSetId');
        break;
      case 'chunksProcessedAt':
        updateData.chunksProcessedAt = validateNullableDateString(value, 'chunksProcessedAt');
        break;
      case 'chunksCount':
        updateData.chunksCount = validateNullableNumber(value, 'chunksCount');
        break;
      case 'chunkingStrategy':
        updateData.chunkingStrategy = validateResolvedChunkingStrategy(value);
        break;
    }
  }

  async updateContent(
    id: string,
    content: string,
    contentHash: string,
    tokenCount: number
  ): Promise<void> {
    const now = new Date();
    await this.db
      .update(fileRecords)
      .set({
        content,
        contentHash,
        tokenCount,
        processedAt: now,
        updatedAt: now,
      })
      .where(eq(fileRecords.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(fileRecords).where(eq(fileRecords.id, id));
  }

  async count(): Promise<number> {
    const [result] = await this.db.select({ count: count() }).from(fileRecords);
    return result?.count ?? 0;
  }

  async countWithContent(): Promise<number> {
    const [result] = await this.db
      .select({ count: count() })
      .from(fileRecords)
      .where(isNotNull(fileRecords.content));
    return result?.count ?? 0;
  }

  async bulkImport(
    requests: FileImportRequest[],
    onProgress?: (completed: number, total: number, current?: string) => void
  ): Promise<FileImportResult[]> {
    const BATCH_SIZE = 100;
    const startTime = Date.now();

    logger.info('Starting bulk import', {
      totalFiles: requests.length,
      batchSize: BATCH_SIZE,
    });

    const results: FileImportResult[] = [];

    // Process in batches to reduce database round-trips
    for (let batchStart = 0; batchStart < requests.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, requests.length);
      const batch = requests.slice(batchStart, batchEnd);

      logger.debug(`Processing batch ${Math.floor(batchStart / BATCH_SIZE) + 1}`, {
        batchStart,
        batchEnd,
        batchSize: batch.length,
      });

      try {
        const batchResults = await this.processBatch(
          batch,
          onProgress,
          batchStart,
          requests.length
        );
        results.push(...batchResults);
      } catch (error) {
        logger.error('Batch processing failed, marking all files in batch as errors', {
          batchStart,
          batchEnd,
          error: error instanceof Error ? error.message : String(error),
        });

        // Mark all files in failed batch as errors
        for (const _request of batch) {
          results.push({
            id: '',
            imported: false,
            existed: false,
            error: `Batch failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
        }
      }
    }

    const duration = Date.now() - startTime;
    const successCount = results.filter((r) => r.imported || r.existed).length;
    const errorCount = results.filter((r) => r.error).length;

    logger.info('Bulk import complete', {
      totalFiles: requests.length,
      successCount,
      errorCount,
      durationMs: duration,
      filesPerSecond: (requests.length / (duration / 1000)).toFixed(2),
    });

    onProgress?.(requests.length, requests.length);
    return results;
  }

  private async processBatch(
    batch: FileImportRequest[],
    onProgress?: (completed: number, total: number, current?: string) => void,
    offset = 0,
    total = 0
  ): Promise<FileImportResult[]> {
    const results: FileImportResult[] = [];

    // Step 1: Pre-compute all content hashes in parallel
    const hashPromises = batch.map(async (request, index) => ({
      index,
      request,
      hash: await generateContentHash(request.content),
    }));

    const hashResults = await Promise.all(hashPromises);
    const hashes = hashResults.map((r) => r.hash);

    // Step 2: Batch query to check which files already exist
    const existingMap = await this.findByContentHashBatch(hashes);

    // Step 3: Prepare records for batch insert
    const recordsToInsert: (typeof fileRecords.$inferInsert)[] = [];
    const now = new Date();

    for (const { index, request, hash } of hashResults) {
      onProgress?.(offset + index, total, request.name);

      const dedupeKey = this.buildDedupKey(hash, request.embeddingSetId);
      const existing = existingMap.get(dedupeKey);

      if (existing) {
        results[index] = {
          id: existing.id,
          imported: false,
          existed: true,
        };
        continue;
      }

      // Count tokens
      const tokenCount = this.countTokensHeuristic(request.content);
      const id = generateUUID();

      const record: typeof fileRecords.$inferInsert = {
        id,
        name: request.name,
        path: request.path,
        size: request.size,
        sourceRootPath: request.sourceRootPath ?? null,
        createdAt: now,
        updatedAt: now,
        content: request.content,
        contentHash: hash,
        tokenCount,
        processedAt: now,
        embeddingSetId: request.embeddingSetId ?? null,
      };

      recordsToInsert.push(record);

      // Track for deduplication within batch
      existingMap.set(dedupeKey, {
        id,
        name: request.name,
        path: request.path,
        size: request.size,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        contentHash: hash,
        ...(request.sourceRootPath ? { sourceRootPath: request.sourceRootPath } : {}),
      });

      results[index] = {
        id,
        imported: true,
        existed: false,
      };
    }

    // Step 4: Batch insert all new records
    // Use onConflictDoNothing to handle race conditions where another process
    // may have inserted the same content hash between our check and insert
    if (recordsToInsert.length > 0) {
      await this.db.insert(fileRecords).values(recordsToInsert).onConflictDoNothing();
      logger.debug('Batch inserted records', { count: recordsToInsert.length });
    }

    return results;
  }

  private async findByContentHashBatch(hashes: string[]): Promise<Map<string, FileRecord>> {
    if (hashes.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .select()
      .from(fileRecords)
      .where(inArray(fileRecords.contentHash, hashes));

    const map = new Map<string, FileRecord>();

    for (const row of rows) {
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

  /**
   * Estimates token count using a simple character-to-token ratio.
   *
   * This is a rough heuristic assuming ~4 characters per token on average.
   * This ratio varies by language and content type:
   * - English prose: ~4-5 chars/token
   * - Code: ~3-4 chars/token
   * - Languages with longer words: may differ
   *
   * For accurate counts, use a proper tokenizer (e.g., tiktoken).
   * This heuristic is used as a fast fallback during bulk import.
   */
  private countTokensHeuristic(content: string): number {
    return Math.ceil(content.length / 4);
  }

  async clearAll(): Promise<number> {
    const [countResult] = await this.db.select({ count: count() }).from(fileRecords);
    const totalCount = countResult?.count ?? 0;

    await this.db.delete(fileRecords);
    return totalCount;
  }

  private fromRow(row: typeof fileRecords.$inferSelect): FileRecord {
    const record: FileRecord = {
      id: row.id,
      name: row.name,
      path: row.path,
      size: row.size,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };

    if (row.sourceRootPath !== null && row.sourceRootPath !== undefined) {
      record.sourceRootPath = row.sourceRootPath;
    }

    // Add optional fields if they exist
    if (row.content !== null && row.content !== undefined) {
      record.content = row.content;
    }
    if (row.contentHash !== null && row.contentHash !== undefined) {
      record.contentHash = row.contentHash;
    }
    if (row.tokenCount !== null && row.tokenCount !== undefined) {
      record.tokenCount = row.tokenCount;
    }
    if (row.processedAt !== null && row.processedAt !== undefined) {
      record.processedAt = row.processedAt.toISOString();
    }
    if (row.embeddingSetId !== null && row.embeddingSetId !== undefined) {
      record.embeddingSetId = row.embeddingSetId;
    }
    if (row.chunksProcessedAt !== null && row.chunksProcessedAt !== undefined) {
      record.chunksProcessedAt = row.chunksProcessedAt.toISOString();
    }
    if (row.chunksCount !== null && row.chunksCount !== undefined) {
      record.chunksCount = row.chunksCount;
    }
    if (row.chunkingStrategy !== null && row.chunkingStrategy !== undefined) {
      record.chunkingStrategy = row.chunkingStrategy;
    }

    return record;
  }
}
