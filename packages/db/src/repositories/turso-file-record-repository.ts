import { generateContentHash, generateUUID } from '@brainstrike/utils';
import type {
  BrainstrikeDbExecutionClient,
  BrainstrikeDbTransactionClient,
} from '../architecture/brainstrike-db-client-contract.js';
import type {
  FileImportRequest,
  FileImportResult,
  FileRecord,
  FileRecordUpdate,
  ManagedCacheEntryMetadata,
} from '../models/file-record.js';
import {
  createQuickOpenCandidateGrams,
  normalizeQuickOpenText,
  replaceQuickOpenNameGrams,
} from '../search/quick-open-name-grams.js';
import { clampQuickOpenLimit, type QuickOpenFileRow } from '../search/quick-open-query.js';
import {
  assertTextContentHasNoNullBytes,
  assertTextContentsHaveNoNullBytes,
} from '../text-content-invariants.js';
import type { FileCollectionStatusSnapshot, IFileRecordRepository } from './interfaces.js';

const MAX_SQLITE_IN_LIST_PARAMS = 900;
const MAX_STATUS_IDS_PER_QUERY = Math.floor((MAX_SQLITE_IN_LIST_PARAMS - 1) / 2);
const BULK_IMPORT_BATCH_SIZE = 100;

const ALLOWED_UPDATE_COLUMNS = new Map<keyof FileRecord, string>([
  ['name', 'name'],
  ['path', 'path'],
  ['size', 'size'],
  ['createdAt', 'created_at'],
  ['updatedAt', 'updated_at'],
  ['content', 'content'],
  ['contentHash', 'content_hash'],
  ['tokenCount', 'token_count'],
  ['processedAt', 'processed_at'],
  ['embeddingSetId', 'embedding_set_id'],
  ['chunksProcessedAt', 'chunks_processed_at'],
  ['chunksCount', 'chunks_count'],
  ['chunkingStrategy', 'chunking_strategy'],
]);
const DATE_FIELDS = new Set<keyof FileRecord>([
  'createdAt',
  'updatedAt',
  'processedAt',
  'chunksProcessedAt',
]);

interface TursoFileRecordRow {
  readonly chunking_strategy: NonNullable<FileRecord['chunkingStrategy']> | null;
  readonly chunks_count: number | null;
  readonly chunks_processed_at: string | null;
  readonly content: string | null;
  readonly content_hash: string | null;
  readonly created_at: string;
  readonly embedding_set_id: string | null;
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly processed_at: string | null;
  readonly size: number;
  readonly token_count: number | null;
  readonly updated_at: string;
}

interface ManagedCacheMetadataRow {
  readonly chunks_count: number | null;
  readonly chunks_processed_at: string | null;
  readonly content_hash: string | null;
  readonly embedding_set_id: string | null;
  readonly id: string;
  readonly mtime_ms: number | null;
  readonly path: string;
  readonly root_id: string | null;
  readonly size: number | null;
  readonly updated_at: string;
}

interface TursoFileCollectionStatusRow {
  readonly fileId: string;
  readonly fileName: string;
  readonly filePath: string;
  readonly lastIndexedAt: string | null;
  readonly otherCollectionsCount: number | string | null;
  readonly searchableChunksCount: number | string | null;
  readonly totalChunksCount: number | string | null;
}

interface TursoQuickOpenFileRow {
  readonly display_name: string | null;
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly root_id: string | null;
}

export class TursoFileRecordRepository implements IFileRecordRepository {
  constructor(private readonly db: BrainstrikeDbExecutionClient) {}

  async create(record: FileRecord): Promise<void> {
    assertNoFileRecordEmbedding(record.embedding);
    await this.db.transaction(async (tx) => {
      await insertFileRecord(tx, record);
      await replaceQuickOpenNameGrams(tx, record.id, record.name);
    });
  }

  async createWithContent(record: FileRecord): Promise<void> {
    assertNoFileRecordEmbedding(record.embedding);
    assertTextContentHasNoNullBytes(record.content, 'File record content');
    await this.db.transaction(async (tx) => {
      await insertFileRecordWithContent(tx, record);
      await replaceQuickOpenNameGrams(tx, record.id, record.name);
    });
  }

  async findById(id: string): Promise<FileRecord | null> {
    const result = await this.db.query<TursoFileRecordRow>(
      `SELECT id, name, path, size, created_at, updated_at, content, content_hash, token_count, processed_at,
        embedding_set_id, chunks_processed_at, chunks_count, chunking_strategy
       FROM file_records
       WHERE id = ?`,
      [id]
    );
    const row = result.rows[0];
    return row ? rowToFileRecord(row) : null;
  }

  async findByIds(ids: readonly string[]): Promise<FileRecord[]> {
    const uniqueIds = uniqueStrings(ids);
    if (uniqueIds.length === 0) {
      return [];
    }

    const records: FileRecord[] = [];
    for (const idChunk of chunkArray(uniqueIds, MAX_SQLITE_IN_LIST_PARAMS)) {
      const result = await this.db.query<TursoFileRecordRow>(
        `SELECT id, name, path, size, created_at, updated_at, content, content_hash, token_count, processed_at,
          embedding_set_id, chunks_processed_at, chunks_count, chunking_strategy
         FROM file_records
         WHERE id IN (${createPlaceholders(idChunk.length)})`,
        idChunk
      );
      records.push(...result.rows.map((row) => rowToFileRecord(row)));
    }
    return records;
  }

  async getFileCollectionStatuses(
    activeCollectionId: string,
    fileIds: readonly string[]
  ): Promise<readonly FileCollectionStatusSnapshot[]> {
    assertEmbeddingSetId(activeCollectionId);
    if (fileIds.length === 0) {
      return [];
    }

    const statuses: FileCollectionStatusSnapshot[] = [];
    for (const idChunk of chunkArray(fileIds, MAX_STATUS_IDS_PER_QUERY)) {
      const requestedRows = idChunk.map(() => '(?, ?)').join(', ');
      const requestedParams = idChunk.flatMap((id, index) => [id, index]);
      const result = await this.db.query<TursoFileCollectionStatusRow>(
        `WITH target(embedding_set_id) AS (VALUES (?)),
          requested(file_id, ordinal) AS (VALUES ${requestedRows})
         SELECT
           fr.id AS fileId,
           fr.name AS fileName,
           fr.path AS filePath,
           COALESCE(SUM(CASE
             WHEN (
               (fc.embedding_set_id = target.embedding_set_id
                OR (fc.embedding_set_id IS NULL AND fr.embedding_set_id = target.embedding_set_id))
               AND fc.embedding IS NOT NULL
             )
             THEN 1
             ELSE 0
           END), 0) AS searchableChunksCount,
           COUNT(fc.id) AS totalChunksCount,
           COUNT(DISTINCT CASE
             WHEN fc.embedding_set_id IS NOT NULL
              AND fc.embedding_set_id != target.embedding_set_id
             THEN fc.embedding_set_id
           END) AS otherCollectionsCount,
           MAX(fc.embedding_updated_at) AS lastIndexedAt
         FROM requested
         JOIN file_records fr ON fr.id = requested.file_id
         JOIN target ON fr.embedding_set_id = target.embedding_set_id
         LEFT JOIN file_chunks fc ON fc.file_record_id = fr.id
         GROUP BY requested.ordinal, fr.id, fr.name, fr.path
         ORDER BY requested.ordinal`,
        [activeCollectionId, ...requestedParams]
      );
      statuses.push(...result.rows.map(rowToFileCollectionStatus));
    }
    return statuses;
  }

  async findByContentHash(contentHash: string): Promise<FileRecord | null> {
    const result = await this.db.query<TursoFileRecordRow>(
      `SELECT id, name, path, size, created_at, updated_at, content, content_hash, token_count, processed_at,
        embedding_set_id, chunks_processed_at, chunks_count, chunking_strategy
       FROM file_records
       WHERE content_hash = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
      [contentHash]
    );
    const row = result.rows[0];
    return row ? rowToFileRecord(row) : null;
  }

  async findAll(): Promise<FileRecord[]> {
    const result = await this.db.query<TursoFileRecordRow>(
      `SELECT id, name, path, size, created_at, updated_at, content, content_hash, token_count, processed_at,
        embedding_set_id, chunks_processed_at, chunks_count, chunking_strategy
       FROM file_records
       ORDER BY updated_at DESC`
    );
    return result.rows.map((row) => rowToFileRecord(row));
  }

  async findAllWithContent(): Promise<FileRecord[]> {
    const result = await this.db.query<TursoFileRecordRow>(
      `SELECT id, name, path, size, created_at, updated_at, content, content_hash, token_count, processed_at,
        embedding_set_id, chunks_processed_at, chunks_count, chunking_strategy
       FROM file_records
       WHERE content IS NOT NULL
       ORDER BY processed_at DESC, updated_at DESC`
    );
    return result.rows.map((row) => rowToFileRecord(row));
  }

  async findByManagedCacheIdentity(
    embeddingSetId: string,
    rootId: string,
    relativePath: string
  ): Promise<FileRecord | null> {
    const result = await this.db.query<TursoFileRecordRow>(
      `SELECT id, name, path, size, created_at, updated_at, content, content_hash, token_count, processed_at,
        embedding_set_id, chunks_processed_at, chunks_count, chunking_strategy
       FROM file_records
       WHERE embedding_set_id = ? AND root_id = ? AND path = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
      [embeddingSetId, rootId, relativePath]
    );
    const row = result.rows[0];
    return row ? rowToFileRecord(row) : null;
  }

  async findByNameSubstring(query: string, limit: number): Promise<QuickOpenFileRow[]> {
    const normalizedQuery = normalizeQuickOpenText(query);
    const boundedLimit = clampQuickOpenLimit(limit);
    if (!normalizedQuery) {
      return [];
    }

    const queryGrams = createQuickOpenCandidateGrams(normalizedQuery);
    if (queryGrams.length === 0) {
      return [];
    }

    const requestedGrams = queryGrams.map(() => '(?)').join(', ');
    const result = await this.db.query<TursoQuickOpenFileRow>(
      `WITH requested_grams(gram) AS (VALUES ${requestedGrams}),
        candidate_files AS (
          SELECT fng.file_record_id
          FROM file_record_name_grams fng
          JOIN requested_grams rg ON rg.gram = fng.gram
          JOIN file_record_name_index fni ON fni.file_record_id = fng.file_record_id
          WHERE instr(fni.normalized_name, ?) > 0
          GROUP BY fng.file_record_id
          HAVING COUNT(DISTINCT fng.gram) = ?
        )
       SELECT fr.id, fr.path, fr.name, fr.root_id, r.display_name
       FROM candidate_files cf
       JOIN file_records fr ON fr.id = cf.file_record_id
       LEFT JOIN roots r ON r.id = fr.root_id
       ORDER BY length(fr.name), fr.path
       LIMIT ?`,
      [...queryGrams, normalizedQuery, queryGrams.length, boundedLimit]
    );
    return result.rows.map((row) => ({
      display_name: row.display_name ?? null,
      id: row.id,
      name: row.name,
      path: row.path,
      root_id: row.root_id ?? null,
    }));
  }

  async listManagedCacheEntries(embeddingSetId: string): Promise<FileRecord[]> {
    const result = await this.db.query<TursoFileRecordRow>(
      `SELECT id, name, path, size, created_at, updated_at, content, content_hash, token_count, processed_at,
        embedding_set_id, chunks_processed_at, chunks_count, chunking_strategy
       FROM file_records
       WHERE embedding_set_id = ? AND root_id IS NOT NULL
       ORDER BY updated_at DESC`,
      [embeddingSetId]
    );
    return result.rows.map((row) => rowToFileRecord(row));
  }

  async listByEmbeddingSet(embeddingSetId: string): Promise<FileRecord[]> {
    assertEmbeddingSetId(embeddingSetId);
    const result = await this.db.query<TursoFileRecordRow>(
      `SELECT id, name, path, size, created_at, updated_at, content, content_hash, token_count, processed_at,
        embedding_set_id, chunks_processed_at, chunks_count, chunking_strategy
       FROM file_records
       WHERE embedding_set_id = ?
       ORDER BY updated_at DESC, id DESC`,
      [embeddingSetId]
    );
    return result.rows.map((row) => rowToFileRecord(row));
  }

  async listByEmbeddingSetPage(
    embeddingSetId: string,
    options: { limit: number; offset: number }
  ): Promise<FileRecord[]> {
    assertEmbeddingSetId(embeddingSetId);
    const limit = readBoundedPageValue(options.limit, 'limit', { min: 1 });
    const offset = readBoundedPageValue(options.offset, 'offset', { min: 0 });
    const result = await this.db.query<TursoFileRecordRow>(
      `SELECT id, name, path, size, created_at, updated_at, content, content_hash, token_count, processed_at,
        embedding_set_id, chunks_processed_at, chunks_count, chunking_strategy
       FROM file_records
       WHERE embedding_set_id = ?
       ORDER BY updated_at DESC, id DESC
       LIMIT ?
       OFFSET ?`,
      [embeddingSetId, limit, offset]
    );
    return result.rows.map((row) => rowToFileRecord(row));
  }

  async listManagedCacheEntryMetadata(
    embeddingSetId: string
  ): Promise<ManagedCacheEntryMetadata[]> {
    const result = await this.db.query<ManagedCacheMetadataRow>(
      `SELECT id, embedding_set_id, root_id, path, content_hash, size, mtime_ms, chunks_count, chunks_processed_at, updated_at
       FROM file_records
       WHERE embedding_set_id = ? AND root_id IS NOT NULL
       ORDER BY updated_at DESC`,
      [embeddingSetId]
    );
    return result.rows.flatMap(rowToManagedCacheMetadata);
  }

  async updateStatMetadata(
    entries: ReadonlyArray<{ fileRecordId: string; mtimeMs: number; size: number }>
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    await this.db.transaction(async (tx) => {
      for (const entry of entries) {
        await tx.exec('UPDATE file_records SET mtime_ms = ?, size = ? WHERE id = ?', [
          Math.floor(entry.mtimeMs),
          Math.floor(entry.size),
          entry.fileRecordId,
        ]);
      }
    });
  }

  async update(id: string, updates: FileRecordUpdate): Promise<void> {
    assertNoFileRecordEmbedding(updates.embedding);
    assertTextContentHasNoNullBytes(updates.content, 'File record content');
    const assignments: string[] = [];
    const params: unknown[] = [];

    for (const [field, value] of Object.entries(updates) as [keyof FileRecordUpdate, unknown][]) {
      if (value === undefined) {
        continue;
      }
      const column = ALLOWED_UPDATE_COLUMNS.get(field as keyof FileRecord);
      if (!column) {
        continue;
      }
      assignments.push(`${column} = ?`);
      params.push(normalizeUpdateValue(field, value));
    }

    if (assignments.length === 0) {
      return;
    }

    params.push(id);
    const nextName = updates.name;
    await this.db.transaction(async (tx) => {
      await tx.exec(`UPDATE file_records SET ${assignments.join(', ')} WHERE id = ?`, params);
      if (nextName !== undefined) {
        await replaceQuickOpenNameGrams(tx, id, String(nextName));
      }
    });
  }

  async updateContent(
    id: string,
    content: string,
    contentHash: string,
    tokenCount: number
  ): Promise<void> {
    assertTextContentHasNoNullBytes(content, 'File record content');
    const now = new Date().toISOString();
    await this.db.exec(
      `UPDATE file_records
       SET content = ?, content_hash = ?, token_count = ?, processed_at = ?, updated_at = ?
       WHERE id = ?`,
      [content, contentHash, tokenCount, now, now, id]
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.exec('DELETE FROM file_record_name_grams WHERE file_record_id = ?', [id]);
      await tx.exec('DELETE FROM file_record_name_index WHERE file_record_id = ?', [id]);
      await tx.exec('DELETE FROM file_records WHERE id = ?', [id]);
    });
  }

  async count(): Promise<number> {
    const result = await this.db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM file_records'
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async countByEmbeddingSet(embeddingSetId: string): Promise<number> {
    assertEmbeddingSetId(embeddingSetId);
    const result = await this.db.query<{ count: number | string | null }>(
      'SELECT COUNT(*) AS count FROM file_records WHERE embedding_set_id = ?',
      [embeddingSetId]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async countWithContent(): Promise<number> {
    const result = await this.db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM file_records WHERE content IS NOT NULL'
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async bulkImport(
    requests: FileImportRequest[],
    onProgress?: (completed: number, total: number, current?: string) => void
  ): Promise<FileImportResult[]> {
    const results: FileImportResult[] = [];
    for (let offset = 0; offset < requests.length; offset += BULK_IMPORT_BATCH_SIZE) {
      const batch = requests.slice(offset, offset + BULK_IMPORT_BATCH_SIZE);
      try {
        results.push(
          ...(await this.processImportBatch(batch, onProgress, offset, requests.length))
        );
      } catch (error) {
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
    onProgress?.(requests.length, requests.length);
    return results;
  }

  async clearAll(): Promise<number> {
    const deletedCount = await this.count();
    await this.db.transaction(async (tx) => {
      await tx.exec('DELETE FROM file_record_name_grams');
      await tx.exec('DELETE FROM file_record_name_index');
      await tx.exec('DELETE FROM file_records');
    });
    return deletedCount;
  }

  private async processImportBatch(
    batch: readonly FileImportRequest[],
    onProgress: ((completed: number, total: number, current?: string) => void) | undefined,
    offset: number,
    total: number
  ): Promise<FileImportResult[]> {
    assertTextContentsHaveNoNullBytes(batch, (request) => request.content, 'File record content');

    const hashResults = await Promise.all(
      batch.map(async (request, index) => ({
        hash: await generateContentHash(request.content),
        index,
        request,
      }))
    );
    const existingByDedupeKey = await this.findByContentHashBatch(
      hashResults.map((row) => row.hash)
    );
    const results: FileImportResult[] = [];
    const recordsToInsert: FileRecord[] = [];
    const now = new Date().toISOString();

    for (const { hash, index, request } of hashResults) {
      onProgress?.(offset + index, total, request.name);
      const dedupeKey = buildDedupeKey(hash, request.embeddingSetId);
      const existing = existingByDedupeKey.get(dedupeKey);
      if (existing) {
        results[index] = { existed: true, id: existing.id, imported: false };
        continue;
      }

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
        tokenCount: countTokensHeuristic(request.content),
        updatedAt: now,
      };
      if (request.embeddingSetId !== undefined) {
        record.embeddingSetId = request.embeddingSetId;
      }
      recordsToInsert.push(record);
      existingByDedupeKey.set(dedupeKey, record);
      results[index] = { existed: false, id, imported: true };
    }

    if (recordsToInsert.length > 0) {
      await this.db.transaction(async (tx) => {
        for (const record of recordsToInsert) {
          await insertFileRecordWithContent(tx, record);
          await replaceQuickOpenNameGrams(tx, record.id, record.name);
        }
      });
    }

    return results;
  }

  private async findByContentHashBatch(
    hashes: readonly string[]
  ): Promise<Map<string, FileRecord>> {
    const uniqueHashes = uniqueStrings(hashes);
    const records = new Map<string, FileRecord>();
    for (const hashChunk of chunkArray(uniqueHashes, MAX_SQLITE_IN_LIST_PARAMS)) {
      if (hashChunk.length === 0) {
        continue;
      }
      const result = await this.db.query<TursoFileRecordRow>(
        `SELECT id, name, path, size, created_at, updated_at, content, content_hash, token_count, processed_at,
          embedding_set_id, chunks_processed_at, chunks_count, chunking_strategy
         FROM file_records
         WHERE content_hash IN (${createPlaceholders(hashChunk.length)})`,
        hashChunk
      );
      for (const row of result.rows) {
        const record = rowToFileRecord(row);
        if (record.contentHash) {
          records.set(buildDedupeKey(record.contentHash, record.embeddingSetId), record);
        }
      }
    }
    return records;
  }
}

async function insertFileRecord(
  db: BrainstrikeDbTransactionClient,
  record: FileRecord
): Promise<void> {
  await db.exec(
    `INSERT INTO file_records (
      id, name, path, size, created_at, updated_at, token_count, embedding_set_id, chunks_count, chunking_strategy
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.name,
      record.path,
      record.size,
      normalizeDateValue(record.createdAt, 'createdAt'),
      normalizeDateValue(record.updatedAt, 'updatedAt'),
      record.tokenCount ?? null,
      record.embeddingSetId ?? null,
      record.chunksCount ?? null,
      record.chunkingStrategy ?? null,
    ]
  );
}

async function insertFileRecordWithContent(
  db: BrainstrikeDbTransactionClient,
  record: FileRecord
): Promise<void> {
  await db.exec(
    `INSERT INTO file_records (
      id, name, path, size, created_at, updated_at, content, content_hash, token_count, processed_at, embedding_set_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.name,
      record.path,
      record.size,
      normalizeDateValue(record.createdAt, 'createdAt'),
      normalizeDateValue(record.updatedAt, 'updatedAt'),
      record.content ?? null,
      record.contentHash ?? null,
      record.tokenCount ?? 0,
      normalizeNullableDateValue(record.processedAt, 'processedAt'),
      record.embeddingSetId ?? null,
    ]
  );
}

function rowToFileRecord(row: TursoFileRecordRow): FileRecord {
  const record: FileRecord = {
    createdAt: normalizeDateValue(row.created_at, 'createdAt'),
    id: row.id,
    name: row.name,
    path: row.path,
    size: Number(row.size),
    updatedAt: normalizeDateValue(row.updated_at, 'updatedAt'),
  };
  if (row.content !== null) {
    record.content = row.content;
  }
  if (row.content_hash !== null) {
    record.contentHash = row.content_hash;
  }
  if (row.token_count !== null) {
    record.tokenCount = Number(row.token_count);
  }
  if (row.processed_at !== null) {
    record.processedAt = normalizeDateValue(row.processed_at, 'processedAt');
  }
  if (row.embedding_set_id !== null) {
    record.embeddingSetId = row.embedding_set_id;
  }
  if (row.chunks_processed_at !== null) {
    record.chunksProcessedAt = normalizeDateValue(row.chunks_processed_at, 'chunksProcessedAt');
  }
  if (row.chunks_count !== null) {
    record.chunksCount = Number(row.chunks_count);
  }
  if (row.chunking_strategy !== null) {
    record.chunkingStrategy = row.chunking_strategy;
  }
  return record;
}

function rowToManagedCacheMetadata(row: ManagedCacheMetadataRow): ManagedCacheEntryMetadata[] {
  if (
    typeof row.embedding_set_id !== 'string' ||
    typeof row.root_id !== 'string' ||
    typeof row.path !== 'string'
  ) {
    return [];
  }
  const metadata: ManagedCacheEntryMetadata = {
    chunksCount: row.chunks_count === null ? null : Number(row.chunks_count),
    chunksProcessedAt: row.chunks_processed_at
      ? normalizeDateValue(row.chunks_processed_at, 'chunksProcessedAt')
      : null,
    contentHash: row.content_hash ?? '',
    embeddingSetId: row.embedding_set_id,
    fileRecordId: row.id,
    mtimeMs: row.mtime_ms === null ? null : Number(row.mtime_ms),
    relativePath: row.path,
    rootId: row.root_id,
    updatedAt: normalizeDateValue(row.updated_at, 'updatedAt'),
  };
  if (row.size !== null) {
    metadata.size = Number(row.size);
  }
  return [metadata];
}

function rowToFileCollectionStatus(
  row: TursoFileCollectionStatusRow
): FileCollectionStatusSnapshot {
  const searchableChunksCount = readNullableNonNegativeInteger(
    row.searchableChunksCount,
    `file ${row.fileId} searchable chunk count`
  );
  const status: FileCollectionStatusSnapshot = {
    fileId: row.fileId,
    fileName: row.fileName,
    filePath: row.filePath,
    otherCollectionsCount: readNullableNonNegativeInteger(
      row.otherCollectionsCount,
      `file ${row.fileId} other collection count`
    ),
    searchableChunksCount,
    searchableInActive: searchableChunksCount > 0,
    totalChunksCount: readNullableNonNegativeInteger(
      row.totalChunksCount,
      `file ${row.fileId} total chunk count`
    ),
  };
  if (row.lastIndexedAt) {
    status.lastIndexedAt = normalizeDateValue(row.lastIndexedAt, 'updatedAt');
  }
  return status;
}

function normalizeUpdateValue(field: keyof FileRecordUpdate, value: unknown): unknown {
  if (value === null) {
    return null;
  }
  return DATE_FIELDS.has(field as keyof FileRecord)
    ? normalizeDateValue(value, field as keyof FileRecord)
    : value;
}

function normalizeNullableDateValue(
  value: string | null | undefined,
  field: keyof FileRecord
): string | null {
  return value === null || value === undefined ? null : normalizeDateValue(value, field);
}

function normalizeDateValue(value: unknown, field: keyof FileRecord): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid file record ${String(field)} date: ${String(value)}`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid file record ${String(field)} date: ${value}`);
  }
  return date.toISOString();
}

function assertNoFileRecordEmbedding(value: unknown): void {
  if (value !== undefined && value !== null) {
    throw new Error(
      'Turso file_records does not support the legacy pgvector embedding column; use file_chunks or embedding_cache instead.'
    );
  }
}

function assertEmbeddingSetId(embeddingSetId: string): void {
  if (!embeddingSetId.trim()) {
    throw new Error('embeddingSetId is required');
  }
}

function readBoundedPageValue(
  value: number,
  field: 'limit' | 'offset',
  options: { min: number }
): number {
  if (!(Number.isFinite(value) && Number.isInteger(value)) || value < options.min) {
    throw new Error(`Invalid file record page ${field}: ${String(value)}`);
  }
  return value;
}

function createPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function readNullableNonNegativeInteger(
  value: number | string | null | undefined,
  fieldName: string
): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!(Number.isInteger(parsed) && parsed >= 0)) {
    throw new Error(`Invalid ${fieldName}: ${String(value)}`);
  }
  return parsed;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function chunkArray<T>(values: readonly T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

function buildDedupeKey(contentHash: string, embeddingSetId?: string | null): string {
  return `${contentHash}::${embeddingSetId?.trim() ? embeddingSetId.trim() : '__default__'}`;
}

function countTokensHeuristic(content: string): number {
  return Math.ceil(content.length / 4);
}
