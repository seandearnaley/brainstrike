/**
 * Drizzle-based FileRecord Repository
 *
 * This is the Drizzle ORM version of the FileRecordRepository.
 * Provides type-safe database operations for file records.
 */

import { createLogger, generateContentHash, generateUUID } from '@brainstrike/utils';
import { count, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type { FileImportRequest, FileImportResult, FileRecord } from '../../models/file-record.js';
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
  'createdAt',
  'updatedAt',
  'content',
  'contentHash',
  'tokenCount',
  'processedAt',
  'embedding',
  'embeddingSetId',
] as const;

export class DrizzleFileRecordRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(record: FileRecord): Promise<void> {
    await this.db.insert(fileRecords).values({
      id: record.id,
      name: record.name,
      path: record.path,
      size: record.size,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
      embeddingSetId: record.embeddingSetId ?? null,
    });
  }

  async createWithContent(record: FileRecord): Promise<void> {
    await this.db.insert(fileRecords).values({
      id: record.id,
      name: record.name,
      path: record.path,
      size: record.size,
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

  async update(id: string, updates: Partial<FileRecord>): Promise<void> {
    const fields = Object.keys(updates).filter((k): k is keyof FileRecord =>
      ALLOWED_UPDATE_FIELDS.includes(k as keyof FileRecord)
    );

    if (fields.length === 0) {
      return;
    }

    const updateData: Partial<typeof fileRecords.$inferInsert> = {};

    for (const field of fields) {
      const value = updates[field];
      switch (field) {
        case 'name':
          updateData.name = value as string;
          break;
        case 'path':
          updateData.path = value as string;
          break;
        case 'size':
          updateData.size = value as number;
          break;
        case 'createdAt':
          updateData.createdAt = new Date(value as string);
          break;
        case 'updatedAt':
          updateData.updatedAt = new Date(value as string);
          break;
        case 'content':
          updateData.content = value as string | null;
          break;
        case 'contentHash':
          updateData.contentHash = value as string | null;
          break;
        case 'tokenCount':
          updateData.tokenCount = value as number | null;
          break;
        case 'processedAt':
          updateData.processedAt = value ? new Date(value as string) : null;
          break;
        case 'embeddingSetId':
          updateData.embeddingSetId = value as string | null;
          break;
      }
    }

    await this.db.update(fileRecords).set(updateData).where(eq(fileRecords.id, id));
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
      });

      results[index] = {
        id,
        imported: true,
        existed: false,
      };
    }

    // Step 4: Batch insert all new records
    if (recordsToInsert.length > 0) {
      await this.db.insert(fileRecords).values(recordsToInsert);
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

    // Add optional fields if they exist
    if (row.content !== null) {
      record.content = row.content;
    }
    if (row.contentHash !== null) {
      record.contentHash = row.contentHash;
    }
    if (row.tokenCount !== null) {
      record.tokenCount = row.tokenCount;
    }
    if (row.processedAt !== null) {
      record.processedAt = row.processedAt.toISOString();
    }
    if (row.embeddingSetId !== null) {
      record.embeddingSetId = row.embeddingSetId;
    }

    return record;
  }
}
