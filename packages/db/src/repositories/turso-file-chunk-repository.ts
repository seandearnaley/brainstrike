import { MAX_EMBEDDING_DIMENSION } from '@brainstrike/types';
import type {
  BrainstrikeDbExecutionClient,
  BrainstrikeDbTransactionClient,
} from '../architecture/brainstrike-db-client-contract.js';
import type {
  ChunkSearchOptions,
  ChunkSearchResult,
  FileChunk,
  FileChunkInsert,
  FileChunkUpdate,
  FTSSearchOptions,
  FTSSearchResult,
} from '../models/file-chunk.js';
import type { GrepCandidate, GrepCandidateOptions } from '../models/grep.js';
import {
  assertTextContentHasNoNullBytes,
  assertTextContentsHaveNoNullBytes,
} from '../text-content-invariants.js';

const MAX_SQLITE_PARAMS = 900;
const FILE_CHUNK_COLUMN_COUNT = 18;
const BATCH_SIZE = Math.floor(MAX_SQLITE_PARAMS / FILE_CHUNK_COLUMN_COUNT);
const FILE_CHUNK_COLUMNS = `
  id,
  file_record_id,
  chunk_index,
  content,
  content_hash,
  token_count,
  chunk_type,
  chunk_size,
  start_line,
  end_line,
  start_offset,
  end_offset,
  embedding,
  embedding_set_id,
  embedding_updated_at,
  embedding_hash,
  created_at,
  updated_at
`.trim();

interface TursoFileChunkRow {
  readonly chunk_index: number | string;
  readonly chunk_size: number | string | null;
  readonly chunk_type: FileChunk['chunkType'] | null;
  readonly content: string;
  readonly content_hash: string | null;
  readonly created_at: string;
  readonly embedding: ArrayBuffer | Uint8Array | string | null;
  readonly embedding_hash: string | null;
  readonly embedding_set_id: string | null;
  readonly embedding_updated_at: string | null;
  readonly end_line: number | string | null;
  readonly end_offset: number | string | null;
  readonly file_record_id: string;
  readonly id: string;
  readonly start_line: number | string | null;
  readonly start_offset: number | string | null;
  readonly token_count: number | string | null;
  readonly updated_at: string;
}

interface TursoStatsRow {
  readonly average_token_count: number | string | null;
  readonly chunk_type: string | null;
  readonly chunks_with_embeddings: number | string;
  readonly type_count: number | string;
}

interface TursoCountRow {
  readonly count: number | string | null;
}

interface TursoCoverageRow {
  readonly chunksWithEmbeddingsForSet: number | string | null;
  readonly totalChunks: number | string | null;
}

interface TursoEmbeddingSetDimensionRow {
  readonly dimensions: number | string | null;
  readonly id: string;
}

export class TursoFileChunkRepository {
  constructor(private readonly db: BrainstrikeDbExecutionClient) {}

  async findById(id: string): Promise<FileChunk | null> {
    const result = await this.db.query<TursoFileChunkRow>(
      `SELECT ${FILE_CHUNK_COLUMNS}
         FROM file_chunks
        WHERE id = ?`,
      [id]
    );
    const row = result.rows[0];
    return row ? mapRowToChunk(row) : null;
  }

  async findByFileRecordId(fileRecordId: string): Promise<FileChunk[]> {
    const result = await this.db.query<TursoFileChunkRow>(
      `SELECT ${FILE_CHUNK_COLUMNS}
         FROM file_chunks
        WHERE file_record_id = ?
        ORDER BY chunk_index ASC`,
      [fileRecordId]
    );
    return result.rows.map((row) => mapRowToChunk(row));
  }

  async insert(chunk: FileChunkInsert): Promise<FileChunk> {
    const rows = await this.insertManyWithClient(this.db, [chunk]);
    const inserted = rows[0];
    if (!inserted) {
      throw new Error(`Failed to insert Turso file chunk ${chunk.id}.`);
    }
    return inserted;
  }

  async insertMany(chunks: FileChunkInsert[]): Promise<FileChunk[]> {
    if (chunks.length === 0) {
      return [];
    }
    return await this.db.transaction(async (tx) => this.insertManyWithClient(tx, chunks));
  }

  async insertManyWithTx(
    tx: BrainstrikeDbTransactionClient,
    chunks: FileChunkInsert[]
  ): Promise<FileChunk[]> {
    if (chunks.length === 0) {
      return [];
    }
    return await this.insertManyWithClient(tx, chunks);
  }

  async update(chunk: FileChunkUpdate): Promise<FileChunk | null> {
    assertTextContentHasNoNullBytes(chunk.content, 'File chunk content');
    const existing = await this.resolveExistingChunkForUpdate(chunk);
    const assignments: string[] = [];
    const params: unknown[] = [];

    appendColumn(assignments, params, 'content', chunk.content);
    appendColumn(assignments, params, 'content_hash', chunk.contentHash);
    appendColumn(assignments, params, 'token_count', chunk.tokenCount);
    appendColumn(assignments, params, 'chunk_type', chunk.chunkType);
    appendColumn(assignments, params, 'chunk_size', chunk.chunkSize);
    appendColumn(assignments, params, 'start_line', chunk.startLine);
    appendColumn(assignments, params, 'end_line', chunk.endLine);
    appendColumn(assignments, params, 'start_offset', chunk.startOffset);
    appendColumn(assignments, params, 'end_offset', chunk.endOffset);

    if (chunk.embedding !== undefined) {
      const validationSetId = chunk.embeddingSetId ?? existing?.embeddingSetId ?? null;
      await validateEmbeddings(this.db, [
        { embedding: chunk.embedding, embeddingSetId: validationSetId },
      ]);
      appendColumn(assignments, params, 'embedding', encodeEmbeddingBlob(chunk.embedding));
      appendColumn(
        assignments,
        params,
        'embedding_updated_at',
        normalizeDateValue(chunk.embeddingUpdatedAt ?? chunk.updatedAt, 'embeddingUpdatedAt')
      );
      appendColumn(assignments, params, 'embedding_set_id', chunk.embeddingSetId);
      appendColumn(assignments, params, 'embedding_hash', chunk.embeddingHash);
    }

    appendColumn(
      assignments,
      params,
      'updated_at',
      normalizeDateValue(chunk.updatedAt, 'updatedAt')
    );

    params.push(chunk.id);
    const result = await this.db.query<TursoFileChunkRow>(
      `UPDATE file_chunks
          SET ${assignments.join(', ')}
        WHERE id = ?
        RETURNING ${FILE_CHUNK_COLUMNS}`,
      params
    );
    const row = result.rows[0];
    return row ? mapRowToChunk(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      'DELETE FROM file_chunks WHERE id = ? RETURNING id',
      [id]
    );
    return result.rows.length > 0;
  }

  async deleteByFileRecordId(fileRecordId: string): Promise<number> {
    const result = await this.db.query<{ id: string }>(
      'DELETE FROM file_chunks WHERE file_record_id = ? RETURNING id',
      [fileRecordId]
    );
    return result.rows.length;
  }

  async searchSimilar(
    _queryEmbedding: number[],
    _options: ChunkSearchOptions = {}
  ): Promise<ChunkSearchResult[]> {
    throw new Error(
      'TursoFileChunkRepository.searchSimilar requires the Turso vector search slice.'
    );
  }

  async fullTextSearch(
    _query: string,
    _options: FTSSearchOptions = {}
  ): Promise<FTSSearchResult[]> {
    throw new Error('TursoFileChunkRepository.fullTextSearch requires the Turso FTS search slice.');
  }

  async findGrepCandidates(_options: GrepCandidateOptions): Promise<GrepCandidate[]> {
    throw new Error(
      'TursoFileChunkRepository.findGrepCandidates requires the Turso grep search slice.'
    );
  }

  async findAll(): Promise<FileChunk[]> {
    const result = await this.db.query<TursoFileChunkRow>(
      `SELECT ${FILE_CHUNK_COLUMNS}
         FROM file_chunks
        ORDER BY created_at DESC`
    );
    return result.rows.map((row) => mapRowToChunk(row));
  }

  async getStats(): Promise<{
    totalChunks: number;
    chunksWithEmbeddings: number;
    averageTokenCount: number;
    chunkTypeDistribution: Record<string, number>;
  }> {
    const result = await this.db.query<TursoStatsRow>(
      `SELECT
         chunk_type,
         COUNT(*) AS type_count,
         SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS chunks_with_embeddings,
         AVG(token_count) AS average_token_count
       FROM file_chunks
       GROUP BY chunk_type`
    );
    let totalTokens = 0;
    const stats = {
      totalChunks: 0,
      chunksWithEmbeddings: 0,
      averageTokenCount: 0,
      chunkTypeDistribution: {} as Record<string, number>,
    };

    for (const row of result.rows) {
      const typeCount = readNonNegativeInteger(row.type_count, 'file chunk type count');
      const embeddedCount = readNonNegativeInteger(
        row.chunks_with_embeddings,
        'file chunk embedded count'
      );
      const averageTokenCount = readNullableFiniteNumber(
        row.average_token_count,
        'file chunk average token count'
      );
      const chunkType = readRequiredText(row.chunk_type, 'file chunk type');

      stats.totalChunks += typeCount;
      stats.chunksWithEmbeddings += embeddedCount;
      stats.chunkTypeDistribution[chunkType] = typeCount;
      totalTokens += averageTokenCount * typeCount;
    }

    if (stats.totalChunks > 0) {
      stats.averageTokenCount = totalTokens / stats.totalChunks;
    }
    return stats;
  }

  async getCoverageForSet(embeddingSetId: string): Promise<{
    totalChunks: number;
    chunksWithEmbeddingsForSet: number;
  }> {
    if (!embeddingSetId) {
      throw new Error('embeddingSetId is required');
    }
    const result = await this.db.query<TursoCoverageRow>(
      `SELECT
         COUNT(*) AS totalChunks,
         SUM(
           CASE
             WHEN (
               (c.embedding_set_id = ? OR (c.embedding_set_id IS NULL AND fr.embedding_set_id = ?))
               AND c.embedding IS NOT NULL
             )
             THEN 1
             ELSE 0
           END
         ) AS chunksWithEmbeddingsForSet
       FROM file_chunks c
       JOIN file_records fr ON fr.id = c.file_record_id
       WHERE fr.embedding_set_id = ?`,
      [embeddingSetId, embeddingSetId, embeddingSetId]
    );
    const row = result.rows[0];
    return {
      totalChunks: readNullableNonNegativeInteger(row?.totalChunks, 'coverage total chunks'),
      chunksWithEmbeddingsForSet: readNullableNonNegativeInteger(
        row?.chunksWithEmbeddingsForSet,
        'coverage embedded chunks'
      ),
    };
  }

  async clearEmbeddingsForSet(embeddingSetId: string): Promise<number> {
    if (!embeddingSetId) {
      throw new Error('embeddingSetId is required');
    }
    const cleared = await this.db.transaction(async (tx) => {
      const clearedResult = await tx.query<{ id: string }>(
        `UPDATE file_chunks
            SET embedding = NULL,
                embedding_updated_at = NULL,
                embedding_hash = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE embedding_set_id = ?
            AND embedding IS NOT NULL
        RETURNING id`,
        [embeddingSetId]
      );
      await refreshCollectionIndexingStatsForSet(tx, embeddingSetId);
      return clearedResult.rows.length;
    });
    return cleared;
  }

  async clearAll(): Promise<number> {
    const count = await this.countRows('SELECT COUNT(*) AS count FROM file_chunks');
    await this.db.exec('DELETE FROM file_chunks');
    return count;
  }

  private async resolveExistingChunkForUpdate(chunk: FileChunkUpdate): Promise<FileChunk | null> {
    if (chunk.embedding !== undefined && !chunk.embeddingSetId) {
      return this.findById(chunk.id);
    }
    return null;
  }

  private async insertManyWithClient(
    db: BrainstrikeDbTransactionClient,
    chunks: FileChunkInsert[]
  ): Promise<FileChunk[]> {
    if (chunks.length === 0) {
      return [];
    }
    assertTextContentsHaveNoNullBytes(chunks, (chunk) => chunk.content, 'File chunk content');
    await validateEmbeddings(
      db,
      chunks.map((chunk) =>
        chunk.embedding === undefined
          ? { embeddingSetId: chunk.embeddingSetId ?? null }
          : { embedding: chunk.embedding, embeddingSetId: chunk.embeddingSetId ?? null }
      )
    );

    const inserted: FileChunk[] = [];
    for (const batch of batchArray(chunks, BATCH_SIZE)) {
      const values = batch.map(() => `(${createPlaceholders(FILE_CHUNK_COLUMN_COUNT)})`).join(', ');
      const params = batch.flatMap((chunk) => toInsertParams(chunk));
      const result = await db.query<TursoFileChunkRow>(
        `INSERT INTO file_chunks (${FILE_CHUNK_COLUMNS})
         VALUES ${values}
         ON CONFLICT (id) DO UPDATE SET
           file_record_id = excluded.file_record_id,
           chunk_index = excluded.chunk_index,
           content = excluded.content,
           content_hash = excluded.content_hash,
           token_count = excluded.token_count,
           chunk_type = excluded.chunk_type,
           chunk_size = excluded.chunk_size,
           start_line = excluded.start_line,
           end_line = excluded.end_line,
           start_offset = excluded.start_offset,
           end_offset = excluded.end_offset,
           embedding = excluded.embedding,
           embedding_set_id = excluded.embedding_set_id,
           embedding_updated_at = excluded.embedding_updated_at,
           embedding_hash = excluded.embedding_hash,
           updated_at = excluded.updated_at
         RETURNING ${FILE_CHUNK_COLUMNS}`,
        params
      );
      inserted.push(...result.rows.map((row) => mapRowToChunk(row)));
    }
    return sortLikeInput(inserted, chunks);
  }

  private async countRows(sql: string, params?: readonly unknown[]): Promise<number> {
    const result = await this.db.query<TursoCountRow>(sql, params);
    return readNullableNonNegativeInteger(result.rows[0]?.count, 'file chunk count');
  }
}

function toInsertParams(chunk: FileChunkInsert): unknown[] {
  return [
    chunk.id,
    chunk.fileRecordId,
    chunk.chunkIndex,
    chunk.content,
    chunk.contentHash,
    chunk.tokenCount,
    chunk.chunkType,
    chunk.chunkSize,
    chunk.startLine ?? null,
    chunk.endLine ?? null,
    chunk.startOffset ?? null,
    chunk.endOffset ?? null,
    encodeEmbeddingBlob(chunk.embedding),
    chunk.embeddingSetId ?? null,
    chunk.embedding
      ? normalizeDateValue(chunk.embeddingUpdatedAt ?? chunk.updatedAt, 'embeddingUpdatedAt')
      : null,
    chunk.embeddingHash ?? null,
    normalizeDateValue(chunk.createdAt, 'createdAt'),
    normalizeDateValue(chunk.updatedAt, 'updatedAt'),
  ];
}

function appendColumn(
  assignments: string[],
  params: unknown[],
  column: string,
  value: unknown | undefined
): void {
  if (value === undefined) {
    return;
  }
  assignments.push(`${column} = ?`);
  params.push(value);
}

async function validateEmbeddings(
  db: BrainstrikeDbTransactionClient,
  embeddingInputs: ReadonlyArray<{
    readonly embedding?: readonly number[];
    readonly embeddingSetId: string | null;
  }>
): Promise<void> {
  const setIds = [
    ...new Set(
      embeddingInputs
        .filter((input) => input.embedding !== undefined && input.embeddingSetId !== null)
        .map((input) => input.embeddingSetId as string)
    ),
  ];
  const dimensionsBySet = await readEmbeddingSetDimensions(db, setIds);

  for (const input of embeddingInputs) {
    if (input.embedding === undefined) {
      continue;
    }
    if (!Array.isArray(input.embedding)) {
      throw new Error(
        `Invalid embedding: expected number array, received ${typeof input.embedding} instead.`
      );
    }
    for (const value of input.embedding) {
      if (!Number.isFinite(value)) {
        throw new Error('Embeddings must contain only finite numeric values.');
      }
    }
    if (input.embedding.length <= 0) {
      throw new Error('Embedding dimension 0 is invalid. Expected a positive integer.');
    }
    if (input.embedding.length > MAX_EMBEDDING_DIMENSION) {
      throw new Error(
        `Embedding dimension ${input.embedding.length} exceeds Turso storage maximum of ${MAX_EMBEDDING_DIMENSION}.`
      );
    }
    if (!input.embeddingSetId) {
      continue;
    }
    const expectedDimension = dimensionsBySet.get(input.embeddingSetId);
    if (expectedDimension === undefined) {
      throw new Error(
        `Embedding set ${input.embeddingSetId} is missing or has invalid dimensions.`
      );
    }
    if (input.embedding.length !== expectedDimension) {
      throw new Error(
        `Embedding dimension mismatch: received ${input.embedding.length}, expected ${expectedDimension}.`
      );
    }
  }
}

async function readEmbeddingSetDimensions(
  db: BrainstrikeDbTransactionClient,
  embeddingSetIds: readonly string[]
): Promise<Map<string, number>> {
  const dimensions = new Map<string, number>();
  if (embeddingSetIds.length === 0) {
    return dimensions;
  }
  for (const idBatch of batchArray(embeddingSetIds, MAX_SQLITE_PARAMS)) {
    const result = await db.query<TursoEmbeddingSetDimensionRow>(
      `SELECT id, dimensions
         FROM embedding_sets
        WHERE id IN (${createPlaceholders(idBatch.length)})`,
      idBatch
    );
    for (const row of result.rows) {
      dimensions.set(
        row.id,
        readPositiveInteger(row.dimensions, `embedding set ${row.id} dimensions`)
      );
    }
  }
  return dimensions;
}

async function refreshCollectionIndexingStatsForSet(
  db: BrainstrikeDbTransactionClient,
  embeddingSetId: string
): Promise<void> {
  await db.exec(
    `INSERT INTO collection_indexing_stats (
       embedding_set_id,
       file_count,
       chunk_count,
       embedded_chunk_count,
       pending_chunk_count,
       dirty,
       last_refreshed_at
     )
     SELECT
       s.id,
       (
         SELECT COUNT(*)
           FROM file_records fr
          WHERE fr.embedding_set_id = s.id
       ),
       (
         SELECT COUNT(*)
           FROM file_chunks c
          WHERE c.embedding_set_id = s.id
       ),
       (
         SELECT COUNT(*)
           FROM file_chunks c
          WHERE c.embedding_set_id = s.id
            AND c.embedding IS NOT NULL
       ),
       (
         SELECT COUNT(*)
           FROM file_chunks c
          WHERE c.embedding_set_id = s.id
            AND c.embedding IS NULL
       ),
       0,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       FROM embedding_sets s
      WHERE s.id = ?
     ON CONFLICT (embedding_set_id) DO UPDATE SET
       file_count = excluded.file_count,
       chunk_count = excluded.chunk_count,
       embedded_chunk_count = excluded.embedded_chunk_count,
       pending_chunk_count = excluded.pending_chunk_count,
       dirty = 0,
       last_refreshed_at = excluded.last_refreshed_at`,
    [embeddingSetId]
  );
}

function mapRowToChunk(row: TursoFileChunkRow): FileChunk {
  // The greenfield baseline permits nullable content_hash/chunk_type for raw
  // compatibility probes, but repository-authored FileChunk rows must carry the
  // non-null model contract. Do not coalesce malformed rows into searchable data.
  const contentHash = readRequiredText(row.content_hash, `file chunk ${row.id} content_hash`);
  const tokenCount = readNullableNonNegativeInteger(
    row.token_count,
    `file chunk ${row.id} token_count`
  );
  const chunkType = readChunkType(row.chunk_type, row.id);
  const chunkSize = readNullableNonNegativeInteger(
    row.chunk_size,
    `file chunk ${row.id} chunk_size`
  );
  const embedding = decodeEmbeddingBlob(row.embedding, row.id);
  return {
    chunkIndex: readNonNegativeInteger(row.chunk_index, `file chunk ${row.id} chunk_index`),
    chunkSize,
    chunkType,
    content: row.content,
    contentHash,
    createdAt: row.created_at,
    ...(embedding && { embedding, embeddingDimensions: embedding.length }),
    ...(row.embedding_hash !== null && { embeddingHash: row.embedding_hash }),
    ...(row.embedding_set_id !== null && { embeddingSetId: row.embedding_set_id }),
    ...(row.embedding_updated_at !== null && { embeddingUpdatedAt: row.embedding_updated_at }),
    ...(row.end_line !== null && {
      endLine: readInteger(row.end_line, `file chunk ${row.id} end_line`),
    }),
    ...(row.end_offset !== null && {
      endOffset: readInteger(row.end_offset, `file chunk ${row.id} end_offset`),
    }),
    fileRecordId: row.file_record_id,
    id: row.id,
    ...(row.start_line !== null && {
      startLine: readInteger(row.start_line, `file chunk ${row.id} start_line`),
    }),
    ...(row.start_offset !== null && {
      startOffset: readInteger(row.start_offset, `file chunk ${row.id} start_offset`),
    }),
    tokenCount,
    updatedAt: row.updated_at,
  };
}

function encodeEmbeddingBlob(embedding: readonly number[] | undefined): Uint8Array | null {
  if (embedding === undefined) {
    return null;
  }
  return new TextEncoder().encode(JSON.stringify(embedding));
}

function decodeEmbeddingBlob(
  embedding: ArrayBuffer | Uint8Array | string | null,
  chunkId: string
): number[] | undefined {
  if (embedding === null) {
    return;
  }
  const text = typeof embedding === 'string' ? embedding : new TextDecoder().decode(embedding);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Failed to decode Turso embedding blob for chunk ${chunkId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (
    !(
      Array.isArray(parsed) &&
      parsed.every((value) => typeof value === 'number' && Number.isFinite(value))
    )
  ) {
    throw new Error(`Invalid Turso embedding blob for chunk ${chunkId}.`);
  }
  return parsed;
}

function sortLikeInput(
  rows: readonly FileChunk[],
  inputs: readonly FileChunkInsert[]
): FileChunk[] {
  const order = new Map(inputs.map((input, index) => [input.id, index]));
  return [...rows].sort((left, right) => {
    const leftOrder = order.get(left.id);
    const rightOrder = order.get(right.id);
    return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
  });
}

function batchArray<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function createPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function readChunkType(
  value: FileChunk['chunkType'] | null,
  chunkId: string
): FileChunk['chunkType'] {
  if (value === 'text' || value === 'code' || value === 'sentence' || value === 'recursive') {
    return value;
  }
  throw new Error(`Invalid file chunk ${chunkId} chunk_type: ${String(value)}`);
}

function readRequiredText(value: string | null | undefined, fieldName: string): string {
  if (typeof value === 'string') {
    return value;
  }
  throw new Error(`${fieldName} is required.`);
}

function readNullableFiniteNumber(
  value: number | string | null | undefined,
  fieldName: string
): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${fieldName}: ${String(value)}`);
  }
  return parsed;
}

function readNullableNonNegativeInteger(
  value: number | string | null | undefined,
  fieldName: string
): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return readNonNegativeInteger(value, fieldName);
}

function readNonNegativeInteger(value: number | string, fieldName: string): number {
  const parsed = readInteger(value, fieldName);
  if (parsed < 0) {
    throw new Error(`Invalid ${fieldName}: ${String(value)}`);
  }
  return parsed;
}

function readPositiveInteger(value: number | string | null, fieldName: string): number {
  if (value === null) {
    throw new Error(`Invalid ${fieldName}: null`);
  }
  const parsed = readInteger(value, fieldName);
  if (parsed <= 0) {
    throw new Error(`Invalid ${fieldName}: ${String(value)}`);
  }
  return parsed;
}

function readInteger(value: number | string, fieldName: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${fieldName}: ${String(value)}`);
  }
  return parsed;
}

function normalizeDateValue(value: string, fieldName: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new Error(`Invalid file chunk ${fieldName} date: ${value}`);
  }
  return value;
}
