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
  buildEmbeddingJobDedupeKeySqlExpression,
  EMBEDDING_JOB_NULL_SET_DEDUPE_SEGMENT,
} from '../queue/embedding-job-dedupe-key.js';
import {
  createGrepContentCandidateGrams,
  normalizeGrepContentText,
  replaceGrepContentIndex,
} from '../search/grep-content-grams.js';
import {
  assertTextContentHasNoNullBytes,
  assertTextContentsHaveNoNullBytes,
} from '../text-content-invariants.js';
import { MAX_INLINE_FILE_PATHS } from './_shared.js';

const MAX_SQLITE_PARAMS = 900;
const GREP_CANDIDATE_MAX_LIMIT = 500;
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

export const TURSO_FILE_CHUNK_REPOSITORY_MARKER = 'brainstrike:turso-file-chunk-repository';

export interface TursoFileChunkRepositoryMarker {
  readonly brainstrikeRepositoryKind: typeof TURSO_FILE_CHUNK_REPOSITORY_MARKER;
}

export function isTursoFileChunkRepository(
  repository: unknown
): repository is TursoFileChunkRepositoryMarker {
  return (
    typeof repository === 'object' &&
    repository !== null &&
    (repository as { readonly brainstrikeRepositoryKind?: unknown }).brainstrikeRepositoryKind ===
      TURSO_FILE_CHUNK_REPOSITORY_MARKER
  );
}

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

interface TursoCollectionEmbeddingCoverageRow {
  readonly chunksMissingSourceRange: number | string | null;
  readonly pendingReindexFileCount: number | string | null;
  readonly totalChunks: number | string | null;
  readonly totalFiles: number | string | null;
}

interface TursoEmbeddedChunksByFileRow {
  readonly embeddedChunks: number | string | null;
  readonly fileRecordId: string;
}

interface TursoEmbeddingSetDimensionRow {
  readonly dimensions: number | string | null;
  readonly id: string;
}

interface TursoGrepCandidateRow {
  readonly content: string;
  readonly display_name: string | null;
  readonly path: string;
  readonly root_id: string | null;
  readonly start_line: number | string | null;
}

export interface TursoEmbeddingBackfillCandidate {
  readonly contentHash: string;
  readonly fileRecordId: string;
  readonly id: string;
}

export interface TursoEmbeddingBackfillCandidateDiagnostics {
  readonly candidateCount: number;
  readonly chunkCount: number;
  readonly embeddedChunkCount: number;
  readonly failedJobs: number;
  readonly fileCount: number;
  readonly missingContentHashCount: number;
  readonly pendingChunkCount: number;
  readonly queuedOrRunningJobs: number;
}

export interface TursoEmbeddingBackfillCandidateOptions {
  readonly afterChunkId?: string | null;
  readonly embeddingSetId: string;
  readonly limit: number;
  readonly queue?: string;
}

interface TursoEmbeddingBackfillCandidateRow {
  readonly contentHash: string | null;
  readonly fileRecordId: string;
  readonly id: string;
}

interface TursoEmbeddingBackfillDiagnosticsRow {
  readonly candidateCount: number | string | null;
  readonly chunkCount: number | string | null;
  readonly embeddedChunkCount: number | string | null;
  readonly failedJobs: number | string | null;
  readonly fileCount: number | string | null;
  readonly missingContentHashCount: number | string | null;
  readonly pendingChunkCount: number | string | null;
  readonly queuedOrRunningJobs: number | string | null;
}

const DEFAULT_EMBEDDING_BACKFILL_QUEUE = 'embeddings';
const EMBEDDING_BACKFILL_DEDUPE_KEY_SQL = buildEmbeddingJobDedupeKeySqlExpression({
  chunkIdExpression: 'c.id',
  contentHashExpression: 'c.content_hash',
  embeddingSetIdExpression: '?',
});

export class TursoFileChunkRepository implements TursoFileChunkRepositoryMarker {
  readonly brainstrikeRepositoryKind = TURSO_FILE_CHUNK_REPOSITORY_MARKER;

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
    const rows = await this.db.transaction(async (tx) => this.insertManyWithClient(tx, [chunk]));
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
    return this.db.transaction(async (tx) => this.updateWithClient(tx, chunk));
  }

  async updateWithTx(
    tx: BrainstrikeDbTransactionClient,
    chunk: FileChunkUpdate
  ): Promise<FileChunk | null> {
    return this.updateWithClient(tx, chunk);
  }

  private async updateWithClient(
    db: BrainstrikeDbTransactionClient,
    chunk: FileChunkUpdate
  ): Promise<FileChunk | null> {
    assertTextContentHasNoNullBytes(chunk.content, 'File chunk content');
    const existing = await this.resolveExistingChunkForUpdate(db, chunk);
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
      await validateEmbeddings(db, [
        { embedding: chunk.embedding, embeddingSetId: validationSetId },
      ]);
      appendColumn(assignments, params, 'embedding', encodeEmbeddingBlob(chunk.embedding));
      appendColumn(
        assignments,
        params,
        'embedding_updated_at',
        normalizeDateValue(chunk.embeddingUpdatedAt ?? chunk.updatedAt, 'embeddingUpdatedAt')
      );
    } else if (chunk.embeddingUpdatedAt !== undefined) {
      appendColumn(
        assignments,
        params,
        'embedding_updated_at',
        normalizeDateValue(chunk.embeddingUpdatedAt, 'embeddingUpdatedAt')
      );
    }
    if (chunk.embedding === undefined && chunk.embeddingSetId !== undefined) {
      if (!existing) {
        return null;
      }
      await validateEmbeddingSetMetadataUpdate(
        db,
        existing.embedding === undefined
          ? { embeddingSetId: chunk.embeddingSetId }
          : { embedding: existing.embedding, embeddingSetId: chunk.embeddingSetId }
      );
    }
    appendColumn(assignments, params, 'embedding_set_id', chunk.embeddingSetId);
    appendColumn(assignments, params, 'embedding_hash', chunk.embeddingHash);

    appendColumn(
      assignments,
      params,
      'updated_at',
      normalizeDateValue(chunk.updatedAt, 'updatedAt')
    );

    params.push(chunk.id);
    const result = await db.query<TursoFileChunkRow>(
      `UPDATE file_chunks
          SET ${assignments.join(', ')}
        WHERE id = ?
        RETURNING ${FILE_CHUNK_COLUMNS}`,
      params
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    if (chunk.content !== undefined) {
      await replaceGrepContentIndex(db, row.id, row.content);
    }
    return mapRowToChunk(row);
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

  async findGrepCandidates(options: GrepCandidateOptions): Promise<GrepCandidate[]> {
    const { caseSensitive, embeddingSetId, filePaths, likePattern, limit, rootId } = options;
    const boundedLimit = readGrepCandidateLimit(limit);

    const conditions: string[] = [];
    const params: unknown[] = [];
    let candidateCteSql = '';
    let candidateParams: unknown[] = [];
    let candidateSourceSql = 'file_chunks fc';
    let contentIndexJoinSql = '';
    if (likePattern !== null) {
      const literal = unescapeLikeLiteral(likePattern);
      const grams = createGrepContentCandidateGrams(literal, caseSensitive);
      if (grams.length === 0) {
        throw new Error('Grep candidate literal must not be empty.');
      }
      const requestedGrams = grams.map(() => '(?)').join(', ');
      candidateCteSql = `WITH requested_grams(gram) AS (VALUES ${requestedGrams}),
           candidate_chunks AS (
             SELECT gc.file_chunk_id
               FROM file_chunk_content_grams gc
               JOIN requested_grams rg ON rg.gram = gc.gram
              WHERE gc.case_sensitive = ?
              GROUP BY gc.file_chunk_id
             HAVING COUNT(DISTINCT gc.gram) = ?
           )`;
      candidateParams = [...grams, caseSensitive ? 1 : 0, grams.length];
      candidateSourceSql = 'candidate_chunks cc JOIN file_chunks fc ON fc.id = cc.file_chunk_id';
      contentIndexJoinSql = 'JOIN file_chunk_content_index fci ON fci.file_chunk_id = fc.id';
      if (caseSensitive) {
        conditions.push('instr(fc.content, ?) > 0');
        params.push(literal);
      } else {
        conditions.push('instr(fci.normalized_content, ?) > 0');
        params.push(normalizeGrepContentText(literal));
      }
    }
    if (embeddingSetId !== undefined) {
      conditions.push('fc.embedding_set_id = ?');
      params.push(embeddingSetId);
    }
    if (rootId !== undefined) {
      conditions.push('fr.root_id = ?');
      params.push(rootId);
    }
    if (filePaths !== undefined) {
      if (filePaths.length === 0) {
        return [];
      }
      if (filePaths.length > MAX_INLINE_FILE_PATHS) {
        throw new Error(
          `findGrepCandidates filePaths limit exceeded (${filePaths.length} > ${MAX_INLINE_FILE_PATHS}).`
        );
      }
      const paths = Array.from(filePaths);
      conditions.push(`fr.path IN (${createPlaceholders(paths.length)})`);
      params.push(...paths);
    }
    params.push(boundedLimit);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.db.query<TursoGrepCandidateRow>(
      `${candidateCteSql}
       SELECT fc.content, fc.start_line, fr.path, fr.root_id, r.display_name
         FROM ${candidateSourceSql}
         ${contentIndexJoinSql}
         JOIN file_records fr ON fr.id = fc.file_record_id
         LEFT JOIN roots r ON r.id = fr.root_id
         ${whereClause}
        ORDER BY fr.path, fc.chunk_index
        LIMIT ?`,
      [...candidateParams, ...params]
    );

    return result.rows.map((row) => ({
      content: row.content,
      filePath: row.path,
      rootId: row.root_id,
      rootName: row.display_name,
      startLine:
        row.start_line === null
          ? null
          : readInteger(row.start_line, `grep candidate ${row.path} start line`),
    }));
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

  async getCollectionEmbeddingCoverage(embeddingSetId: string): Promise<{
    chunksMissingSourceRange: number;
    pendingReindexFileCount: number;
    totalChunks: number;
    totalFiles: number;
  }> {
    if (!embeddingSetId) {
      throw new Error('embeddingSetId is required');
    }
    const result = await this.db.query<TursoCollectionEmbeddingCoverageRow>(
      `SELECT
         COUNT(DISTINCT fr.id) AS totalFiles,
         COUNT(fc.id) AS totalChunks,
         COUNT(DISTINCT CASE WHEN fr.chunks_processed_at IS NULL THEN fr.id END)
           AS pendingReindexFileCount,
         SUM(
           CASE
             WHEN fc.id IS NOT NULL
              AND (
                fc.start_line IS NULL
                OR fc.end_line IS NULL
                OR fc.start_offset IS NULL
                OR fc.end_offset IS NULL
              )
             THEN 1
             ELSE 0
           END
         ) AS chunksMissingSourceRange
       FROM file_records fr
       LEFT JOIN file_chunks fc ON fc.file_record_id = fr.id
       WHERE fr.embedding_set_id = ?`,
      [embeddingSetId]
    );
    const row = result.rows[0];
    return {
      chunksMissingSourceRange: readNullableNonNegativeInteger(
        row?.chunksMissingSourceRange,
        'collection coverage chunks missing source range'
      ),
      pendingReindexFileCount: readNullableNonNegativeInteger(
        row?.pendingReindexFileCount,
        'collection coverage pending reindex files'
      ),
      totalChunks: readNullableNonNegativeInteger(
        row?.totalChunks,
        'collection coverage total chunks'
      ),
      totalFiles: readNullableNonNegativeInteger(
        row?.totalFiles,
        'collection coverage total files'
      ),
    };
  }

  async countEmbeddedByFileRecordIds(
    fileRecordIds: readonly string[],
    embeddingSetId: string
  ): Promise<Map<string, number>> {
    if (!embeddingSetId) {
      throw new Error('embeddingSetId is required');
    }
    const distinctFileRecordIds = Array.from(new Set(fileRecordIds));
    if (distinctFileRecordIds.length === 0) {
      return new Map();
    }
    const result = await this.db.query<TursoEmbeddedChunksByFileRow>(
      `SELECT
         c.file_record_id AS fileRecordId,
         SUM(
           CASE
             WHEN (
               (c.embedding_set_id = ? OR (c.embedding_set_id IS NULL AND fr.embedding_set_id = ?))
               AND c.embedding IS NOT NULL
             )
             THEN 1
             ELSE 0
           END
         ) AS embeddedChunks
       FROM file_chunks c
       JOIN file_records fr ON fr.id = c.file_record_id
       WHERE fr.embedding_set_id = ?
         AND c.file_record_id IN (${createPlaceholders(distinctFileRecordIds.length)})
       GROUP BY c.file_record_id`,
      [embeddingSetId, embeddingSetId, embeddingSetId, ...distinctFileRecordIds]
    );
    return new Map(
      result.rows.map((row) => [
        row.fileRecordId,
        readNullableNonNegativeInteger(row.embeddedChunks, 'embedded chunks by file record'),
      ])
    );
  }

  async countEmbeddingBackfillCandidates(
    embeddingSetId: string,
    options: { readonly queue?: string } = {}
  ): Promise<number> {
    const targetEmbeddingSetId = requireNonEmptyText(embeddingSetId, 'embeddingSetId');
    const queue = resolveEmbeddingBackfillQueue(options.queue);
    await this.assertNoMissingBackfillContentHashes(targetEmbeddingSetId);
    const result = await this.db.query<TursoCountRow>(
      `SELECT COUNT(*) AS count
         FROM file_chunks c
         JOIN file_records fr ON fr.id = c.file_record_id
        WHERE (
                c.embedding_set_id = ?
                OR (c.embedding_set_id IS NULL AND fr.embedding_set_id = ?)
          )
          AND c.embedding IS NULL
          AND c.content_hash IS NOT NULL
          AND NOT EXISTS (
                SELECT 1
                  FROM job_queue j
                 WHERE j.queue = ?
                   AND j.job_type = 'embed_chunk'
                   AND j.state IN ('queued', 'running')
                   AND (
                         j.dedupe_key = ${EMBEDDING_BACKFILL_DEDUPE_KEY_SQL}
                         OR j.dedupe_key = ${EMBEDDING_BACKFILL_DEDUPE_KEY_SQL}
                       )
              )`,
      [
        targetEmbeddingSetId,
        targetEmbeddingSetId,
        queue,
        targetEmbeddingSetId,
        EMBEDDING_JOB_NULL_SET_DEDUPE_SEGMENT,
      ]
    );
    return readNullableNonNegativeInteger(
      result.rows[0]?.count,
      'embedding backfill candidate count'
    );
  }

  async getEmbeddingBackfillCandidateDiagnostics(
    embeddingSetId: string,
    options: { readonly queue?: string } = {}
  ): Promise<TursoEmbeddingBackfillCandidateDiagnostics> {
    const targetEmbeddingSetId = requireNonEmptyText(embeddingSetId, 'embeddingSetId');
    const queue = resolveEmbeddingBackfillQueue(options.queue);
    const result = await this.db.query<TursoEmbeddingBackfillDiagnosticsRow>(
      `WITH scoped_chunks AS (
         SELECT
           c.id,
           c.content_hash,
           c.embedding
         FROM file_chunks c
         JOIN file_records fr ON fr.id = c.file_record_id
        WHERE (
                c.embedding_set_id = ?
                OR (c.embedding_set_id IS NULL AND fr.embedding_set_id = ?)
              )
       ),
       chunk_counts AS (
         SELECT
           COUNT(*) AS chunkCount,
           COALESCE(SUM(CASE WHEN c.embedding IS NULL THEN 1 ELSE 0 END), 0) AS pendingChunkCount,
           COALESCE(SUM(CASE WHEN c.embedding IS NULL AND c.content_hash IS NULL THEN 1 ELSE 0 END), 0) AS missingContentHashCount,
           COALESCE(
             SUM(
               CASE
                 WHEN c.embedding IS NULL
                   AND c.content_hash IS NOT NULL
                   AND NOT EXISTS (
                         SELECT 1
                           FROM job_queue j
                          WHERE j.queue = ?
                            AND j.job_type = 'embed_chunk'
                            AND j.state IN ('queued', 'running')
                            AND (
                                  j.dedupe_key = ${EMBEDDING_BACKFILL_DEDUPE_KEY_SQL}
                                  OR j.dedupe_key = ${EMBEDDING_BACKFILL_DEDUPE_KEY_SQL}
                                )
                       )
                 THEN 1
                 ELSE 0
               END
             ),
             0
           ) AS candidateCount,
           COALESCE(SUM(CASE WHEN c.embedding IS NOT NULL THEN 1 ELSE 0 END), 0) AS embeddedChunkCount
         FROM scoped_chunks c
       )
       SELECT
         (
           SELECT COUNT(*)
             FROM file_records fr
            WHERE fr.embedding_set_id = ?
         ) AS fileCount,
         chunk_counts.candidateCount AS candidateCount,
         chunk_counts.chunkCount AS chunkCount,
         chunk_counts.embeddedChunkCount AS embeddedChunkCount,
         (
           SELECT COUNT(*)
             FROM job_queue j
            WHERE j.queue = ?
              AND j.job_type = 'embed_chunk'
              AND j.embedding_set_id = ?
              AND j.state IN ('queued', 'running')
         ) AS queuedOrRunningJobs,
         (
           SELECT COUNT(*)
             FROM job_queue j
            WHERE j.queue = ?
              AND j.job_type = 'embed_chunk'
              AND j.embedding_set_id = ?
              AND j.state = 'failed'
         ) AS failedJobs,
         chunk_counts.missingContentHashCount AS missingContentHashCount,
         chunk_counts.pendingChunkCount AS pendingChunkCount
       FROM chunk_counts`,
      [
        targetEmbeddingSetId,
        targetEmbeddingSetId,
        queue,
        targetEmbeddingSetId,
        EMBEDDING_JOB_NULL_SET_DEDUPE_SEGMENT,
        targetEmbeddingSetId,
        queue,
        targetEmbeddingSetId,
        queue,
        targetEmbeddingSetId,
      ]
    );
    const row = result.rows[0];
    return {
      candidateCount: readNullableNonNegativeInteger(
        row?.candidateCount,
        'embedding backfill diagnostics candidate count'
      ),
      chunkCount: readNullableNonNegativeInteger(
        row?.chunkCount,
        'embedding backfill diagnostics chunk count'
      ),
      embeddedChunkCount: readNullableNonNegativeInteger(
        row?.embeddedChunkCount,
        'embedding backfill diagnostics embedded chunk count'
      ),
      failedJobs: readNullableNonNegativeInteger(
        row?.failedJobs,
        'embedding backfill diagnostics failed jobs'
      ),
      fileCount: readNullableNonNegativeInteger(
        row?.fileCount,
        'embedding backfill diagnostics file count'
      ),
      missingContentHashCount: readNullableNonNegativeInteger(
        row?.missingContentHashCount,
        'embedding backfill diagnostics missing content hash count'
      ),
      pendingChunkCount: readNullableNonNegativeInteger(
        row?.pendingChunkCount,
        'embedding backfill diagnostics pending chunk count'
      ),
      queuedOrRunningJobs: readNullableNonNegativeInteger(
        row?.queuedOrRunningJobs,
        'embedding backfill diagnostics queued or running jobs'
      ),
    };
  }

  async findEmbeddingBackfillCandidates(
    options: TursoEmbeddingBackfillCandidateOptions
  ): Promise<TursoEmbeddingBackfillCandidate[]> {
    const targetEmbeddingSetId = requireNonEmptyText(options.embeddingSetId, 'embeddingSetId');
    const queue = resolveEmbeddingBackfillQueue(options.queue);
    const limit = readPositiveInteger(options.limit, 'embedding backfill candidate limit');
    const afterChunkId = options.afterChunkId ?? null;
    await this.assertNoMissingBackfillContentHashes(targetEmbeddingSetId);
    const result = await this.db.query<TursoEmbeddingBackfillCandidateRow>(
      `SELECT
         c.id AS id,
         c.file_record_id AS fileRecordId,
         c.content_hash AS contentHash
       FROM file_chunks c
       JOIN file_records fr ON fr.id = c.file_record_id
      WHERE (
              c.embedding_set_id = ?
              OR (c.embedding_set_id IS NULL AND fr.embedding_set_id = ?)
            )
        AND c.embedding IS NULL
        AND c.content_hash IS NOT NULL
        AND (? IS NULL OR c.id > ?)
        AND NOT EXISTS (
              SELECT 1
                FROM job_queue j
               WHERE j.queue = ?
                 AND j.job_type = 'embed_chunk'
                 AND j.state IN ('queued', 'running')
                 AND (
                       j.dedupe_key = ${EMBEDDING_BACKFILL_DEDUPE_KEY_SQL}
                       OR j.dedupe_key = ${EMBEDDING_BACKFILL_DEDUPE_KEY_SQL}
                     )
            )
      ORDER BY c.id ASC
      LIMIT ?`,
      [
        targetEmbeddingSetId,
        targetEmbeddingSetId,
        afterChunkId,
        afterChunkId,
        queue,
        targetEmbeddingSetId,
        EMBEDDING_JOB_NULL_SET_DEDUPE_SEGMENT,
        limit,
      ]
    );
    return result.rows.map((row) => ({
      contentHash: readRequiredText(row.contentHash, `file chunk ${row.id} content_hash`),
      fileRecordId: row.fileRecordId,
      id: row.id,
    }));
  }

  private async assertNoMissingBackfillContentHashes(embeddingSetId: string): Promise<void> {
    const result = await this.db.query<TursoCountRow>(
      `SELECT COUNT(*) AS count
         FROM file_chunks c
         JOIN file_records fr ON fr.id = c.file_record_id
        WHERE (
                c.embedding_set_id = ?
                OR (c.embedding_set_id IS NULL AND fr.embedding_set_id = ?)
              )
          AND c.embedding IS NULL
          AND c.content_hash IS NULL`,
      [embeddingSetId, embeddingSetId]
    );
    const missingCount = readNullableNonNegativeInteger(
      result.rows[0]?.count,
      'embedding backfill missing content hash count'
    );
    if (missingCount > 0) {
      throw new Error(
        `Embedding backfill cannot enqueue ${missingCount} chunk(s) for embedding set '${embeddingSetId}' because content_hash is missing.`
      );
    }
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

  private async resolveExistingChunkForUpdate(
    db: BrainstrikeDbTransactionClient,
    chunk: FileChunkUpdate
  ): Promise<FileChunk | null> {
    if (chunk.embedding !== undefined && !chunk.embeddingSetId) {
      return this.findByIdWithClient(db, chunk.id);
    }
    if (chunk.embedding === undefined && chunk.embeddingSetId !== undefined) {
      return this.findByIdWithClient(db, chunk.id);
    }
    return null;
  }

  private async findByIdWithClient(
    db: BrainstrikeDbTransactionClient,
    id: string
  ): Promise<FileChunk | null> {
    const result = await db.query<TursoFileChunkRow>(
      `SELECT ${FILE_CHUNK_COLUMNS}
         FROM file_chunks
        WHERE id = ?`,
      [id]
    );
    const row = result.rows[0];
    return row ? mapRowToChunk(row) : null;
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
      for (const row of result.rows) {
        await replaceGrepContentIndex(db, row.id, row.content);
        inserted.push(mapRowToChunk(row));
      }
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

async function validateEmbeddingSetMetadataUpdate(
  db: BrainstrikeDbTransactionClient,
  input: { readonly embedding?: readonly number[]; readonly embeddingSetId: string }
): Promise<void> {
  const dimensionsBySet = await readEmbeddingSetDimensions(db, [input.embeddingSetId]);
  const targetDimension = dimensionsBySet.get(input.embeddingSetId);
  if (targetDimension === undefined) {
    throw new Error(`Embedding set ${input.embeddingSetId} is missing or has invalid dimensions.`);
  }
  if (input.embedding === undefined) {
    return;
  }
  if (input.embedding.length !== targetDimension) {
    throw new Error(
      `Embedding dimension mismatch: received ${input.embedding.length}, expected ${targetDimension}.`
    );
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

function requireNonEmptyText(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}

function resolveEmbeddingBackfillQueue(queue: string | undefined): string {
  if (queue === undefined) {
    return DEFAULT_EMBEDDING_BACKFILL_QUEUE;
  }
  return requireNonEmptyText(queue, 'embedding backfill queue');
}

function readGrepCandidateLimit(value: number): number {
  const limit = readPositiveInteger(value, 'grep candidate limit');
  if (limit > GREP_CANDIDATE_MAX_LIMIT) {
    throw new Error(`grep candidate limit ${limit} exceeds maximum ${GREP_CANDIDATE_MAX_LIMIT}.`);
  }
  return limit;
}

function unescapeLikeLiteral(likePattern: string): string {
  let literal = '';
  let escaping = false;
  for (const char of likePattern) {
    if (escaping) {
      literal += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    literal += char;
  }
  return escaping ? `${literal}\\` : literal;
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
