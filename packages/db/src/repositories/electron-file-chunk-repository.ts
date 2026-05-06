import type {
  ChunkSearchOptions,
  ChunkSearchResult,
  FileChunk,
  FileChunkInsert,
  FileChunkUpdate,
} from '../models/file-chunk';
import {
  appendColumn,
  appendColumnIfDefined,
  batchArray,
  createUpdateBuilder,
  MAX_INLINE_FILE_PATHS,
  parseEmbeddingLoose,
  type Queryable,
  type UpdateBuilder,
  validateEmbeddingDimensions,
} from './_shared.js';
import type { ElectronDbAPI } from './electron-file-record-repository';

// Type definition for database row returned by Electron IPC
interface FileChunkRow {
  chunk_index: number;
  chunk_size: number;
  chunk_type: 'text' | 'code' | 'sentence' | 'recursive';
  content: string;
  content_hash: string;
  created_at: string;
  embedding?: string;
  embedding_hash?: string | null;
  // Phase 2 columns
  embedding_set_id?: string | null;
  embedding_updated_at?: string | null;
  file_record_id: string;
  id: string;
  token_count: number;
  updated_at: string;
}

// Type for search result rows with additional fields
interface FileChunkSearchRow extends FileChunkRow {
  rank: string;
  similarity: string;
}

// Type for stats query rows
interface FileChunkStatsRow {
  average_token_count: string;
  chunk_type: string;
  chunks_with_embeddings: string;
  total_chunks: string;
  type_count: string;
}

export class ElectronFileChunkRepository {
  constructor(private readonly db: ElectronDbAPI) {}

  async findById(id: string): Promise<FileChunk | null> {
    const result = await this.db.query(
      'SELECT id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, embedding::text AS embedding, embedding_set_id, embedding_updated_at, embedding_hash, created_at, updated_at FROM file_chunks WHERE id = $1',
      [id]
    );
    return result.rows[0] ? this.mapRowToChunk(result.rows[0] as FileChunkRow) : null;
  }

  async findByFileRecordId(fileRecordId: string): Promise<FileChunk[]> {
    const result = await this.db.query(
      'SELECT id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, embedding::text AS embedding, embedding_set_id, embedding_updated_at, embedding_hash, created_at, updated_at FROM file_chunks WHERE file_record_id = $1 ORDER BY chunk_index ASC',
      [fileRecordId]
    );
    return result.rows.map((row) => this.mapRowToChunk(row as FileChunkRow));
  }

  async insert(chunk: FileChunkInsert): Promise<FileChunk> {
    await validateEmbeddingDimensions(this.db as unknown as Queryable, [
      { embedding: chunk.embedding, embeddingSetId: chunk.embeddingSetId ?? null },
    ]);
    const result = await this.db.query(
      `INSERT INTO file_chunks (
        id, file_record_id, chunk_index, content, content_hash,
        token_count, chunk_type, chunk_size, embedding, embedding_set_id, embedding_updated_at, embedding_hash, content_tsvector, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, to_tsvector('english', $4), $13, $14)
      ON CONFLICT (id) DO UPDATE SET
        content = EXCLUDED.content,
        content_hash = EXCLUDED.content_hash,
        token_count = EXCLUDED.token_count,
        chunk_type = EXCLUDED.chunk_type,
        chunk_size = EXCLUDED.chunk_size,
        content_tsvector = to_tsvector('english', EXCLUDED.content),
        embedding = EXCLUDED.embedding,
        embedding_set_id = EXCLUDED.embedding_set_id,
        embedding_updated_at = EXCLUDED.embedding_updated_at,
        embedding_hash = EXCLUDED.embedding_hash,
        updated_at = EXCLUDED.updated_at
      RETURNING *`,
      [
        chunk.id,
        chunk.fileRecordId,
        chunk.chunkIndex,
        chunk.content,
        chunk.contentHash,
        chunk.tokenCount,
        chunk.chunkType,
        chunk.chunkSize,
        chunk.embedding ? `[${chunk.embedding.join(',')}]` : null,
        chunk.embeddingSetId ?? null,
        chunk.embedding ? (chunk.embeddingUpdatedAt ?? chunk.updatedAt) : null,
        chunk.embeddingHash ?? null,
        chunk.createdAt,
        chunk.updatedAt,
      ]
    );
    return this.mapRowToChunk(result.rows[0] as FileChunkRow);
  }

  async insertMany(chunks: FileChunkInsert[]): Promise<FileChunk[]> {
    if (chunks.length === 0) {
      return [];
    }

    await validateEmbeddingDimensions(this.db as unknown as Queryable, chunks);

    // Batch inserts to avoid parameter limit issues (250 rows per batch)
    const BatchSize = 250;
    const batches = batchArray(chunks, BatchSize);
    const allResults: FileChunk[] = [];

    // Process each batch in a transaction
    await this.db.query('BEGIN');
    try {
      for (const batch of batches) {
        const values = batch
          .map((_, index) => {
            const baseIndex = index * 14;
            return `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8}, $${baseIndex + 9}, $${baseIndex + 10}, $${baseIndex + 11}, $${baseIndex + 12}, to_tsvector('english', $${baseIndex + 4}), $${baseIndex + 13}, $${baseIndex + 14})`;
          })
          .join(', ');

        const params = batch.flatMap((chunk) => [
          chunk.id,
          chunk.fileRecordId,
          chunk.chunkIndex,
          chunk.content,
          chunk.contentHash,
          chunk.tokenCount,
          chunk.chunkType,
          chunk.chunkSize,
          chunk.embedding ? `[${chunk.embedding.join(',')}]` : null,
          chunk.embeddingSetId ?? null,
          chunk.embedding ? (chunk.embeddingUpdatedAt ?? chunk.updatedAt) : null,
          chunk.embeddingHash ?? null,
          chunk.createdAt,
          chunk.updatedAt,
        ]);

        const result = await this.db.query(
          `INSERT INTO file_chunks (
              id, file_record_id, chunk_index, content, content_hash, 
              token_count, chunk_type, chunk_size, embedding, embedding_set_id, embedding_updated_at, embedding_hash, content_tsvector, created_at, updated_at
            ) VALUES ${values} 
            ON CONFLICT (id) DO UPDATE SET
              content = EXCLUDED.content,
              content_hash = EXCLUDED.content_hash,
              token_count = EXCLUDED.token_count,
              chunk_type = EXCLUDED.chunk_type,
              chunk_size = EXCLUDED.chunk_size,
              content_tsvector = to_tsvector('english', EXCLUDED.content),
              embedding = EXCLUDED.embedding,
              embedding_set_id = EXCLUDED.embedding_set_id,
              embedding_updated_at = EXCLUDED.embedding_updated_at,
              embedding_hash = EXCLUDED.embedding_hash,
              updated_at = EXCLUDED.updated_at
            RETURNING *`,
          params
        );

        allResults.push(...result.rows.map((row) => this.mapRowToChunk(row as FileChunkRow)));
      }
      await this.db.query('COMMIT');
    } catch (error) {
      await this.db.query('ROLLBACK');
      throw error;
    }

    return allResults;
  }

  async insertManyWithTx(
    tx: Pick<ElectronDbAPI, 'query'>,
    chunks: FileChunkInsert[]
  ): Promise<FileChunk[]> {
    if (chunks.length === 0) {
      return [];
    }

    await validateEmbeddingDimensions(tx as unknown as Queryable, chunks);

    const BatchSize = 250;
    const batches = batchArray(chunks, BatchSize);
    const allResults: FileChunk[] = [];
    for (const batch of batches) {
      const values = batch
        .map((_, index) => {
          const baseIndex = index * 14;
          return `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8}, $${baseIndex + 9}, $${baseIndex + 10}, $${baseIndex + 11}, $${baseIndex + 12}, to_tsvector('english', $${baseIndex + 4}), $${baseIndex + 13}, $${baseIndex + 14})`;
        })
        .join(', ');

      const params = batch.flatMap((chunk) => [
        chunk.id,
        chunk.fileRecordId,
        chunk.chunkIndex,
        chunk.content,
        chunk.contentHash,
        chunk.tokenCount,
        chunk.chunkType,
        chunk.chunkSize,
        chunk.embedding ? `[${chunk.embedding.join(',')}]` : null,
        chunk.embeddingSetId ?? null,
        chunk.embedding ? (chunk.embeddingUpdatedAt ?? chunk.updatedAt) : null,
        chunk.embeddingHash ?? null,
        chunk.createdAt,
        chunk.updatedAt,
      ]);

      const result = await tx.query(
        `INSERT INTO file_chunks (
            id, file_record_id, chunk_index, content, content_hash,
            token_count, chunk_type, chunk_size, embedding, embedding_set_id, embedding_updated_at, embedding_hash, content_tsvector, created_at, updated_at
          ) VALUES ${values}
          ON CONFLICT (id) DO UPDATE SET
            content = EXCLUDED.content,
            content_hash = EXCLUDED.content_hash,
            token_count = EXCLUDED.token_count,
            chunk_type = EXCLUDED.chunk_type,
            chunk_size = EXCLUDED.chunk_size,
            content_tsvector = to_tsvector('english', EXCLUDED.content),
            embedding = EXCLUDED.embedding,
            embedding_set_id = EXCLUDED.embedding_set_id,
            embedding_updated_at = EXCLUDED.embedding_updated_at,
            embedding_hash = EXCLUDED.embedding_hash,
            updated_at = EXCLUDED.updated_at
          RETURNING *`,
        params
      );

      allResults.push(...result.rows.map((row) => this.mapRowToChunk(row as FileChunkRow)));
    }
    return allResults;
  }

  async update(chunk: FileChunkUpdate): Promise<FileChunk | null> {
    const builder = createUpdateBuilder();
    const existingChunk = await this.resolveExistingChunkForUpdate(chunk);

    this.appendSimpleUpdates(builder, chunk);
    await this.appendEmbeddingUpdates(builder, chunk, existingChunk);
    appendColumn(builder, 'updated_at', chunk.updatedAt);

    builder.values.push(chunk.id);

    const result = await this.db.query(
      `UPDATE file_chunks SET ${builder.setParts.join(', ')} WHERE id = $${builder.index} RETURNING *`,
      builder.values
    );

    return result.rows[0] ? this.mapRowToChunk(result.rows[0] as FileChunkRow) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM file_chunks WHERE id = $1', [id]);
    return (result as unknown as { rowCount: number }).rowCount > 0;
  }

  async deleteByFileRecordId(fileRecordId: string): Promise<number> {
    const result = await this.db.query('DELETE FROM file_chunks WHERE file_record_id = $1', [
      fileRecordId,
    ]);
    return (result as unknown as { rowCount: number }).rowCount;
  }

  async searchSimilar(
    queryEmbedding: number[],
    options: ChunkSearchOptions = {}
  ): Promise<ChunkSearchResult[]> {
    return this.searchSimilarPgVector(queryEmbedding, options);
  }

  private async searchSimilarPgVector(
    queryEmbedding: number[],
    options: ChunkSearchOptions = {}
  ): Promise<ChunkSearchResult[]> {
    const {
      limit = 10,
      threshold = 0.5,
      fileRecordId,
      chunkType,
      embeddingSetId,
      filePaths,
      selectionSnapshotId,
    } = options;

    if (!embeddingSetId) {
      throw new Error(
        'searchSimilar SQL path requires embeddingSetId to avoid dimension mismatches'
      );
    }

    const normalizedFilePaths = this.normalizeFilePaths(filePaths);
    if (normalizedFilePaths && normalizedFilePaths.length > MAX_INLINE_FILE_PATHS) {
      throw new Error(
        `searchSimilar filePaths limit exceeded (${normalizedFilePaths.length} > ${MAX_INLINE_FILE_PATHS}). ` +
          'Use selectionSnapshotId for large selections.'
      );
    }
    const normalizedSnapshotId = selectionSnapshotId?.trim() || undefined;

    const vectorParam = `[${queryEmbedding.join(',')}]`;
    const params: unknown[] = [vectorParam];
    let paramIndex = 2;
    const whereParts = ['embedding IS NOT NULL'];

    paramIndex = this.appendFilterClause(
      whereParts,
      params,
      paramIndex,
      fileRecordId,
      'file_record_id'
    );
    paramIndex = this.appendFilterClause(whereParts, params, paramIndex, chunkType, 'chunk_type');
    paramIndex = this.appendSelectionFilters(
      whereParts,
      params,
      paramIndex,
      normalizedFilePaths,
      normalizedSnapshotId
    );
    whereParts.push(`embedding_set_id = $${paramIndex}`);
    params.push(embeddingSetId);
    paramIndex += 1;

    const { similarityExpr, orderExpr } = await this.resolveDistanceConfig(
      embeddingSetId,
      queryEmbedding
    );

    try {
      const envObj = (
        globalThis as unknown as {
          process?: { env?: Record<string, string | undefined> };
        }
      ).process?.env;
      const rawEf = Number(envObj?.['HNSW_EF_SEARCH'] ?? '0');
      const ef = Number.isFinite(rawEf) ? Math.max(1, Math.min(Math.floor(rawEf), 2000)) : 60;
      await this.db.query(`SET LOCAL hnsw.ef_search = ${ef}`);
    } catch {
      // best-effort tuning only
    }

    try {
      const envObj = (
        globalThis as unknown as {
          process?: { env?: Record<string, string | undefined> };
        }
      ).process?.env;
      const rawProbes = Number(envObj?.['IVFFLAT_PROBES'] ?? '0');
      if (Number.isFinite(rawProbes) && rawProbes > 0) {
        const probes = Math.max(1, Math.min(Math.floor(rawProbes), 10_000));
        await this.db.query(`SET LOCAL ivfflat.probes = ${probes}`);
      }
    } catch {
      // best-effort tuning only
    }

    const overfetchLimit = Math.max(limit * 10, 100);
    const result = await this.db.query(
      `SELECT *, 
        ${similarityExpr} as similarity,
        ROW_NUMBER() OVER (ORDER BY ${orderExpr}) as rank
      FROM file_chunks 
      WHERE ${whereParts.join(' AND ')}
      ORDER BY ${orderExpr}
      LIMIT $${paramIndex}`,
      [...params, overfetchLimit]
    );

    const filtered = (result.rows as FileChunkSearchRow[]).filter((row) => {
      const similarity = Number(row.similarity);
      return Number.isFinite(similarity) && similarity >= threshold;
    });

    return filtered.slice(0, limit).map((row) => ({
      chunk: this.mapRowToChunk(row),
      similarity: Number(row.similarity),
      rank: Number(row.rank),
    }));
  }

  /**
   * Full-text search on file chunks using PostgreSQL's tsvector/tsquery.
   *
   * Uses the pre-computed `content_tsvector` column with GIN index for fast
   * keyword-based search. Supports multiple query modes:
   * - 'plain': Simple AND of all words
   * - 'websearch': Google-like syntax (OR, quotes, -negation)
   * - 'phrase': Exact phrase matching
   *
   * @param query - Search query string
   * @param options - Search options (limit, filters, query mode, etc.)
   * @returns Array of matching chunks sorted by relevance
   */
  async fullTextSearch(
    query: string,
    options: import('../models/file-chunk').FTSSearchOptions = {}
  ): Promise<import('../models/file-chunk').FTSSearchResult[]> {
    const {
      limit = 10,
      threshold = 0,
      fileRecordId,
      chunkType,
      filePaths,
      selectionSnapshotId,
      queryMode = 'websearch',
      language = 'english',
      rankNormalization = 0,
    } = options;

    // Validate query
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return [];
    }

    const normalizedFilePaths = this.normalizeFilePaths(filePaths);
    if (normalizedFilePaths && normalizedFilePaths.length > MAX_INLINE_FILE_PATHS) {
      throw new Error(
        `fullTextSearch filePaths limit exceeded (${normalizedFilePaths.length} > ${MAX_INLINE_FILE_PATHS}). ` +
          'Use selectionSnapshotId for large selections.'
      );
    }
    const normalizedSnapshotId = selectionSnapshotId?.trim() || undefined;

    // Build tsquery using the appropriate function based on query mode
    const tsqueryFunc = this.getTsqueryFunction(queryMode);
    const params: unknown[] = [language, trimmedQuery];
    let paramIndex = 3;

    // Build WHERE clause
    const whereParts = [
      'content_tsvector IS NOT NULL',
      `content_tsvector @@ ${tsqueryFunc}($1::regconfig, $2)`,
    ];

    paramIndex = this.appendFilterClause(
      whereParts,
      params,
      paramIndex,
      fileRecordId,
      'file_record_id'
    );
    paramIndex = this.appendFilterClause(whereParts, params, paramIndex, chunkType, 'chunk_type');
    paramIndex = this.appendSelectionFilters(
      whereParts,
      params,
      paramIndex,
      normalizedFilePaths,
      normalizedSnapshotId
    );

    // Execute search query with ts_rank for relevance scoring
    const result = await this.db.query(
      `SELECT
        id, file_record_id, chunk_index, content, content_hash,
        token_count, chunk_type, chunk_size, embedding::text AS embedding,
        embedding_set_id, embedding_updated_at, embedding_hash, created_at, updated_at,
        ts_rank(content_tsvector, ${tsqueryFunc}($1::regconfig, $2), ${rankNormalization}) as fts_rank,
        ts_headline($1::regconfig, content, ${tsqueryFunc}($1::regconfig, $2),
          'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15') as headline,
        ROW_NUMBER() OVER (ORDER BY ts_rank(content_tsvector, ${tsqueryFunc}($1::regconfig, $2), ${rankNormalization}) DESC) as position
      FROM file_chunks
      WHERE ${whereParts.join(' AND ')}
      ORDER BY fts_rank DESC
      LIMIT $${paramIndex}`,
      [...params, limit]
    );

    // Map results to FTSSearchResult
    const results: import('../models/file-chunk').FTSSearchResult[] = [];
    for (const row of result.rows) {
      const ftsRow = row as FileChunkRow & { fts_rank: string; headline: string; position: string };
      const rank = Number.parseFloat(ftsRow.fts_rank);

      // Apply threshold filter
      if (threshold > 0 && rank < threshold) {
        continue;
      }

      const ftsResult: import('../models/file-chunk').FTSSearchResult = {
        chunk: this.mapRowToChunk(ftsRow),
        rank,
        position: Number.parseInt(ftsRow.position, 10),
      };
      if (ftsRow.headline) {
        ftsResult.headline = ftsRow.headline;
      }
      results.push(ftsResult);
    }

    return results;
  }

  /**
   * Get the PostgreSQL tsquery function for the given query mode
   */
  private getTsqueryFunction(mode: import('../models/file-chunk').FTSQueryMode): string {
    switch (mode) {
      case 'plain':
        return 'plainto_tsquery';
      case 'phrase':
        return 'phraseto_tsquery';
      default:
        // 'websearch' is the default query mode
        return 'websearch_to_tsquery';
    }
  }

  async findAll(): Promise<FileChunk[]> {
    const result = await this.db.query(
      'SELECT id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, embedding::text AS embedding, embedding_set_id, embedding_updated_at, embedding_hash, created_at, updated_at FROM file_chunks ORDER BY created_at DESC'
    );
    return result.rows.map((row) => this.mapRowToChunk(row as FileChunkRow));
  }

  async getStats(): Promise<{
    totalChunks: number;
    chunksWithEmbeddings: number;
    averageTokenCount: number;
    chunkTypeDistribution: Record<string, number>;
  }> {
    const result = await this.db.query(`
      SELECT 
        COUNT(*) as total_chunks,
        COUNT(embedding) as chunks_with_embeddings,
        AVG(token_count) as average_token_count,
        chunk_type,
        COUNT(*) as type_count
      FROM file_chunks 
      GROUP BY chunk_type
    `);

    const stats = {
      totalChunks: 0,
      chunksWithEmbeddings: 0,
      averageTokenCount: 0,
      chunkTypeDistribution: {} as Record<string, number>,
    };

    for (const row of result.rows) {
      const rowData = row as FileChunkStatsRow;
      stats.totalChunks += Number.parseInt(rowData.type_count, 10);
      stats.chunksWithEmbeddings += Number.parseInt(rowData.chunks_with_embeddings, 10);
      stats.chunkTypeDistribution[rowData.chunk_type] = Number.parseInt(rowData.type_count, 10);
    }

    if (stats.totalChunks > 0) {
      stats.averageTokenCount =
        result.rows.reduce((acc: number, row) => {
          const rowData = row as FileChunkStatsRow;
          return (
            acc +
            Number.parseInt(rowData.average_token_count, 10) *
              Number.parseInt(rowData.type_count, 10)
          );
        }, 0) / stats.totalChunks;
    }

    return stats;
  }

  async clearAll(): Promise<number> {
    const countResult = await this.db.query('SELECT COUNT(*) as count FROM file_chunks');
    const countRow = countResult.rows[0];
    const totalCount =
      countRow && typeof countRow === 'object' && 'count' in countRow
        ? Number((countRow as { count: string }).count)
        : 0;

    await this.db.query('DELETE FROM file_chunks');
    return totalCount;
  }

  /**
   * Get coverage statistics for a specific embedding set.
   * Returns total chunks in the set and how many have embeddings.
   * Required by VectorQueueService for backfill operations.
   */
  async getCoverageForSet(embeddingSetId: string): Promise<{
    totalChunks: number;
    chunksWithEmbeddingsForSet: number;
  }> {
    if (!embeddingSetId) {
      throw new Error('embeddingSetId is required');
    }

    // Query uses same logic as COVERAGE_QUERY in use-vector-queue-state.ts
    // Handles both patterns: embedding_set_id on chunk OR on file_record (legacy)
    const result = await this.db.query(
      `WITH target AS (SELECT $1::text AS embedding_set_id)
       SELECT
         COUNT(*)::text AS "totalChunks",
         COUNT(*) FILTER (
           WHERE (
             c.embedding_set_id = target.embedding_set_id
             OR (c.embedding_set_id IS NULL AND fr.embedding_set_id = target.embedding_set_id)
           )
           AND c.embedding IS NOT NULL
         )::text AS "chunksWithEmbeddingsForSet"
       FROM file_chunks c
       JOIN file_records fr ON fr.id = c.file_record_id
       JOIN target ON fr.embedding_set_id = target.embedding_set_id`,
      [embeddingSetId]
    );

    const row = result.rows[0] as
      | { totalChunks: string; chunksWithEmbeddingsForSet: string }
      | undefined;

    return {
      totalChunks: Number(row?.totalChunks ?? 0),
      chunksWithEmbeddingsForSet: Number(row?.chunksWithEmbeddingsForSet ?? 0),
    };
  }

  /**
   * Clear all embeddings for a specific embedding set.
   * Used by VectorQueueService for backfill operations to reset embeddings.
   *
   * @param embeddingSetId - The embedding set ID whose embeddings should be cleared
   * @returns Number of chunks that had their embeddings cleared
   */
  async clearEmbeddingsForSet(embeddingSetId: string): Promise<number> {
    if (!embeddingSetId) {
      throw new Error('embeddingSetId is required');
    }

    const result = await this.db.query(
      `WITH requested AS (
         SELECT $1::text AS embedding_set_id
       ),
       cleared AS (
         UPDATE file_chunks
            SET embedding = NULL,
                embedding_updated_at = NULL,
                embedding_hash = NULL,
                updated_at = NOW()
           FROM requested
          WHERE file_chunks.embedding_set_id::text = requested.embedding_set_id
            AND file_chunks.embedding IS NOT NULL
          RETURNING file_chunks.id
       ),
       aggregated_files AS (
         SELECT
           fr.embedding_set_id::text AS embedding_set_id,
           COUNT(*)::int AS file_count
         FROM file_records fr
         JOIN requested r ON r.embedding_set_id = fr.embedding_set_id::text
         GROUP BY fr.embedding_set_id::text
       ),
       aggregated_chunks AS (
         SELECT
           c.embedding_set_id::text AS embedding_set_id,
           COUNT(*)::int AS chunk_count,
           COUNT(*) FILTER (WHERE c.embedding IS NOT NULL AND cleared.id IS NULL)::int AS embedded_chunk_count,
           COUNT(*) FILTER (WHERE c.embedding IS NULL OR cleared.id IS NOT NULL)::int AS pending_chunk_count
         FROM file_chunks c
         JOIN requested r ON r.embedding_set_id = c.embedding_set_id::text
         LEFT JOIN cleared ON cleared.id = c.id
         GROUP BY c.embedding_set_id::text
       ),
       refreshed AS (
         INSERT INTO collection_indexing_stats (
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
           COALESCE(af.file_count, 0) AS file_count,
           COALESCE(ac.chunk_count, 0) AS chunk_count,
           COALESCE(ac.embedded_chunk_count, 0) AS embedded_chunk_count,
           COALESCE(ac.pending_chunk_count, 0) AS pending_chunk_count,
           FALSE,
           NOW()
         FROM embedding_sets s
         JOIN requested r ON r.embedding_set_id = s.id::text
         LEFT JOIN aggregated_files af ON af.embedding_set_id = s.id::text
         LEFT JOIN aggregated_chunks ac ON ac.embedding_set_id = s.id::text
         ON CONFLICT (embedding_set_id) DO UPDATE SET
           file_count = EXCLUDED.file_count,
           chunk_count = EXCLUDED.chunk_count,
           embedded_chunk_count = EXCLUDED.embedded_chunk_count,
           pending_chunk_count = EXCLUDED.pending_chunk_count,
           dirty = FALSE,
           last_refreshed_at = EXCLUDED.last_refreshed_at
         RETURNING embedding_set_id
       )
       SELECT
         COUNT(*)::int AS "clearedCount",
         (SELECT COUNT(*)::int FROM refreshed) AS "refreshedCount"
       FROM cleared`,
      [embeddingSetId]
    );

    const row = result.rows[0] as { clearedCount?: number | string } | undefined;
    return Number(row?.clearedCount ?? 0);
  }

  private appendFilterClause(
    whereParts: string[],
    params: unknown[],
    paramIndex: number,
    value: string | undefined,
    column: string
  ): number {
    if (value === undefined) {
      return paramIndex;
    }
    whereParts.push(`${column} = $${paramIndex}`);
    params.push(value);
    return paramIndex + 1;
  }

  private normalizeFilePaths(filePaths?: readonly string[]): string[] | undefined {
    if (!filePaths || filePaths.length === 0) {
      return;
    }
    const trimmed = filePaths.map((path) => path.trim()).filter((path) => path.length > 0);
    if (trimmed.length === 0) {
      return;
    }
    return Array.from(new Set(trimmed));
  }

  private appendSelectionFilters(
    whereParts: string[],
    params: unknown[],
    paramIndex: number,
    filePaths: readonly string[] | undefined,
    selectionSnapshotId: string | undefined
  ): number {
    let nextIndex = paramIndex;
    if (selectionSnapshotId) {
      whereParts.push(
        `EXISTS (\n          SELECT 1\n          FROM selection_snapshot_files ssf\n          JOIN selection_snapshots ss ON ss.id = ssf.snapshot_id\n          JOIN file_records fr ON fr.path = ssf.file_path\n          WHERE ssf.snapshot_id = $${nextIndex}\n            AND (ss.expires_at IS NULL OR ss.expires_at > NOW())\n            AND fr.id = file_chunks.file_record_id\n        )`
      );
      params.push(selectionSnapshotId);
      nextIndex += 1;
    }

    if (filePaths && filePaths.length > 0) {
      whereParts.push(
        `file_record_id IN (\n          SELECT id FROM file_records\n          WHERE path = ANY($${nextIndex}::text[])\n        )`
      );
      params.push(filePaths);
      nextIndex += 1;
    }

    return nextIndex;
  }

  private async resolveDistanceConfig(
    embeddingSetId: string,
    queryEmbedding: number[]
  ): Promise<{ similarityExpr: string; orderExpr: string }> {
    const setRes = await this.db.query(
      'SELECT distance, dimensions FROM embedding_sets WHERE id = $1',
      [embeddingSetId]
    );
    const setRow = setRes.rows[0] as { distance?: string; dimensions?: number } | undefined;
    if (!setRow) {
      throw new Error(`Embedding set ${embeddingSetId} not found.`);
    }
    const expectedDimension = Number(setRow.dimensions ?? Number.NaN);
    if (!Number.isFinite(expectedDimension) || expectedDimension <= 0) {
      throw new Error(`Embedding set ${embeddingSetId} is missing dimension metadata.`);
    }
    if (queryEmbedding.length !== expectedDimension) {
      throw new Error(
        `Query embedding dimension mismatch: received ${queryEmbedding.length}, expected ${expectedDimension} for embedding set ${embeddingSetId}.`
      );
    }

    const distance = (setRow.distance || 'cosine') as 'cosine' | 'l2' | 'ip';
    return this.buildDistanceExpressions(distance);
  }

  private buildDistanceExpressions(distance: 'cosine' | 'l2' | 'ip'): {
    similarityExpr: string;
    orderExpr: string;
  } {
    if (distance === 'l2') {
      return {
        similarityExpr: '(1.0 / (1.0 + (embedding <-> $1::vector)))',
        orderExpr: 'embedding <-> $1::vector',
      };
    }
    if (distance === 'ip') {
      return {
        similarityExpr: '(1.0 / (1.0 + exp(+(embedding <#> $1::vector))))',
        orderExpr: 'embedding <#> $1::vector',
      };
    }
    return {
      similarityExpr: '(1 - ((embedding <=> $1::vector) / 2.0))',
      orderExpr: 'embedding <=> $1::vector',
    };
  }

  private async resolveExistingChunkForUpdate(chunk: FileChunkUpdate): Promise<FileChunk | null> {
    if (chunk.embedding !== undefined && !chunk.embeddingSetId) {
      return this.findById(chunk.id);
    }
    return null;
  }

  private appendSimpleUpdates(builder: UpdateBuilder, chunk: FileChunkUpdate): void {
    if (chunk.content !== undefined) {
      appendColumn(builder, 'content', chunk.content);
      builder.setParts.push(`content_tsvector = to_tsvector('english', $${builder.index - 1})`);
    }

    const simpleFields: [unknown, string][] = [
      [chunk.contentHash, 'content_hash'],
      [chunk.tokenCount, 'token_count'],
      [chunk.chunkType, 'chunk_type'],
      [chunk.chunkSize, 'chunk_size'],
    ];

    for (const [value, column] of simpleFields) {
      appendColumnIfDefined(builder, column, value);
    }
  }

  private async appendEmbeddingUpdates(
    builder: UpdateBuilder,
    chunk: FileChunkUpdate,
    existingChunk: FileChunk | null
  ): Promise<void> {
    if (chunk.embedding === undefined) {
      return;
    }

    const validationSetId = chunk.embeddingSetId ?? existingChunk?.embeddingSetId ?? null;
    await validateEmbeddingDimensions(this.db as unknown as Queryable, [
      { embedding: chunk.embedding, embeddingSetId: validationSetId },
    ]);

    appendColumn(builder, 'embedding', chunk.embedding ? `[${chunk.embedding.join(',')}]` : null);
    appendColumn(builder, 'embedding_updated_at', chunk.embeddingUpdatedAt ?? chunk.updatedAt);
    appendColumnIfDefined(builder, 'embedding_set_id', chunk.embeddingSetId);
    appendColumnIfDefined(builder, 'embedding_hash', chunk.embeddingHash);
  }

  private mapRowToChunk(row: FileChunkRow): FileChunk {
    const embedding = row.embedding ? parseEmbeddingLoose(row.embedding) : undefined;
    return {
      id: row.id,
      fileRecordId: row.file_record_id,
      chunkIndex: row.chunk_index,
      content: row.content,
      contentHash: row.content_hash,
      tokenCount: row.token_count,
      chunkType: row.chunk_type,
      chunkSize: row.chunk_size,
      ...(embedding && { embedding }),
      ...(row.embedding_set_id !== null && { embeddingSetId: row.embedding_set_id }),
      ...(row.embedding_updated_at !== null && { embeddingUpdatedAt: row.embedding_updated_at }),
      ...(row.embedding_hash !== null && { embeddingHash: row.embedding_hash }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
