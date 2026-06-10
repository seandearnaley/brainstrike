import type { PGlite } from '@electric-sql/pglite';
import type {
  ChunkSearchOptions,
  ChunkSearchResult,
  FileChunk,
  FileChunkInsert,
  FileChunkUpdate,
  FTSQueryMode,
  FTSSearchOptions,
  FTSSearchResult,
} from '../models/file-chunk';
import type { GrepCandidate, GrepCandidateOptions } from '../models/grep';
import {
  appendColumn,
  appendColumnIfDefined,
  batchArray,
  computeOverfetchLimit,
  createUpdateBuilder,
  FILE_CHUNK_SELECT_COLUMNS,
  FILE_CHUNK_SELECT_COLUMNS_DIMS_ONLY,
  hnswSearchTuningStatements,
  MAX_INLINE_FILE_PATHS,
  parseEmbeddingLoose,
  type Queryable,
  resolveEmbeddingDimensions,
  type UpdateBuilder,
  validateEmbeddingDimensions,
} from './_shared.js';

// Type definition for database row returned by PGlite
interface FileChunkRow {
  chunk_index: number;
  chunk_size: number;
  chunk_type: 'text' | 'code' | 'sentence' | 'recursive';
  content: string;
  content_hash: string;
  created_at: string;
  embedding?: string;
  /** Projected dimension count (vector_dims) when the full embedding is omitted. */
  embedding_dims?: string | number | null;
  embedding_hash?: string | null;
  // Phase 2 columns
  embedding_set_id?: string | null;
  embedding_updated_at?: string | null;
  end_line?: number | null;
  end_offset?: number | null;
  file_record_id: string;
  id: string;
  start_line?: number | null;
  start_offset?: number | null;
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

export class FileChunkRepository {
  constructor(private readonly db: PGlite) {}

  async findById(id: string): Promise<FileChunk | null> {
    const result = await this.db.query(
      `SELECT ${FILE_CHUNK_SELECT_COLUMNS} FROM file_chunks WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.mapRowToChunk(result.rows[0] as FileChunkRow) : null;
  }

  async findByFileRecordId(fileRecordId: string): Promise<FileChunk[]> {
    const result = await this.db.query(
      `SELECT ${FILE_CHUNK_SELECT_COLUMNS} FROM file_chunks WHERE file_record_id = $1 ORDER BY chunk_index ASC`,
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
        token_count, chunk_type, chunk_size, start_line, end_line, start_offset, end_offset, embedding, embedding_set_id, embedding_updated_at, embedding_hash, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      ON CONFLICT (id) DO UPDATE SET
        content = EXCLUDED.content,
        content_hash = EXCLUDED.content_hash,
        token_count = EXCLUDED.token_count,
        chunk_type = EXCLUDED.chunk_type,
        chunk_size = EXCLUDED.chunk_size,
        start_line = EXCLUDED.start_line,
        end_line = EXCLUDED.end_line,
        start_offset = EXCLUDED.start_offset,
        end_offset = EXCLUDED.end_offset,
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
        chunk.startLine ?? null,
        chunk.endLine ?? null,
        chunk.startOffset ?? null,
        chunk.endOffset ?? null,
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

    // Validate all embeddings before processing in batch
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
            const baseIndex = index * 18;
            return `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8}, $${baseIndex + 9}, $${baseIndex + 10}, $${baseIndex + 11}, $${baseIndex + 12}, $${baseIndex + 13}, $${baseIndex + 14}, $${baseIndex + 15}, $${baseIndex + 16}, $${baseIndex + 17}, $${baseIndex + 18})`;
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
          chunk.startLine ?? null,
          chunk.endLine ?? null,
          chunk.startOffset ?? null,
          chunk.endOffset ?? null,
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
              token_count, chunk_type, chunk_size, start_line, end_line, start_offset, end_offset, embedding, embedding_set_id, embedding_updated_at, embedding_hash, created_at, updated_at
            ) VALUES ${values} 
            ON CONFLICT (id) DO UPDATE SET
              content = EXCLUDED.content,
              content_hash = EXCLUDED.content_hash,
              token_count = EXCLUDED.token_count,
              chunk_type = EXCLUDED.chunk_type,
              chunk_size = EXCLUDED.chunk_size,
              start_line = EXCLUDED.start_line,
              end_line = EXCLUDED.end_line,
              start_offset = EXCLUDED.start_offset,
              end_offset = EXCLUDED.end_offset,
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
    tx: Pick<PGlite, 'query'>,
    chunks: FileChunkInsert[]
  ): Promise<FileChunk[]> {
    if (chunks.length === 0) {
      return [];
    }

    // Validate all embeddings before processing in batch
    await validateEmbeddingDimensions(tx as unknown as Queryable, chunks);

    const BatchSize = 250;
    const batches = batchArray(chunks, BatchSize);
    const allResults: FileChunk[] = [];
    for (const batch of batches) {
      const values = batch
        .map((_, index) => {
          const baseIndex = index * 18;
          return `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8}, $${baseIndex + 9}, $${baseIndex + 10}, $${baseIndex + 11}, $${baseIndex + 12}, $${baseIndex + 13}, $${baseIndex + 14}, $${baseIndex + 15}, $${baseIndex + 16}, $${baseIndex + 17}, $${baseIndex + 18})`;
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
        chunk.startLine ?? null,
        chunk.endLine ?? null,
        chunk.startOffset ?? null,
        chunk.endOffset ?? null,
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
            token_count, chunk_type, chunk_size, start_line, end_line, start_offset, end_offset, embedding, embedding_set_id, embedding_updated_at, embedding_hash, created_at, updated_at
          ) VALUES ${values}
          ON CONFLICT (id) DO UPDATE SET
            content = EXCLUDED.content,
            content_hash = EXCLUDED.content_hash,
            token_count = EXCLUDED.token_count,
            chunk_type = EXCLUDED.chunk_type,
            chunk_size = EXCLUDED.chunk_size,
            start_line = EXCLUDED.start_line,
            end_line = EXCLUDED.end_line,
            start_offset = EXCLUDED.start_offset,
            end_offset = EXCLUDED.end_offset,
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
      efSearch,
      filePaths,
      selectionSnapshotId,
      includeEmbedding = true,
    } = options;

    // Enforce set scoping to avoid dimension mismatch hazards with pgvector
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

    // Resolve distance config and get dimension for index matching
    const { similarityExpr, orderExpr, dimension } = await this.resolveDistanceConfig(
      embeddingSetId,
      queryEmbedding
    );

    const vectorParam = `[${queryEmbedding.join(',')}]`;
    const params: unknown[] = [vectorParam];
    let paramIndex = 2;

    // Build WHERE clause - include vector_dims() to enable partial HNSW index usage
    // The query planner requires this clause to match the partial index predicate
    const whereParts = [
      'embedding IS NOT NULL',
      `vector_dims(embedding) = ${dimension}`, // Enables HNSW index usage
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
    whereParts.push(`embedding_set_id = $${paramIndex}`);
    params.push(embeddingSetId);
    paramIndex += 1;

    // Fetch top candidates by distance; apply threshold in JS to avoid SQL path quirks.
    // Capped via computeOverfetchLimit so a 2,000 limit can't pull 20,000 rows.
    const overfetchLimit = computeOverfetchLimit(limit);
    // Large fan-out reads can project the heavy embedding vector away (keeping
    // only its dimension count) — the distance math still runs in SQL.
    const selectColumns = includeEmbedding ? '*' : FILE_CHUNK_SELECT_COLUMNS_DIMS_ONLY;
    const searchSql = `SELECT ${selectColumns},
        ${similarityExpr} as similarity,
        ROW_NUMBER() OVER (ORDER BY ${orderExpr}) as rank
      FROM file_chunks
      WHERE ${whereParts.join(' AND ')}
      ORDER BY ${orderExpr}
      LIMIT $${paramIndex}`;
    const searchParams = [...params, overfetchLimit];

    // Run the ANN tuning and the search inside ONE transaction. `SET LOCAL` only
    // takes effect within a transaction block, so issuing it autocommit (as the
    // previous code did) was a silent no-op. The tuning widens `hnsw.ef_search`
    // and enables iterative scans so heavily filtered searches keep walking the
    // index until enough rows survive the WHERE clause instead of under-returning.
    const result = await this.runVectorSearchInTransaction(searchSql, searchParams, efSearch);

    const mapped = result.rows.map((row) => {
      const searchRow = row as unknown as FileChunkSearchRow;
      const sim = Number.parseFloat(searchRow.similarity);
      return {
        chunk: this.mapRowToChunk(searchRow),
        similarity: sim,
        rank: Number.parseInt(searchRow.rank, 10),
      } as ChunkSearchResult;
    });

    // Apply threshold in JS and cut to requested limit
    const filtered = mapped.filter(
      (r) => Number.isFinite(r.similarity) && r.similarity >= threshold
    );
    return filtered.slice(0, limit);
  }

  /**
   * Run a pgvector ANN search with HNSW tuning applied via `SET LOCAL` inside a
   * single transaction. `SET LOCAL` only affects the current transaction, so the
   * SELECT must run in the same transaction as the tuning statements. The search
   * is read-only; the transaction is committed on success and rolled back on error.
   */
  private async runVectorSearchInTransaction(
    searchSql: string,
    params: unknown[],
    efSearch?: number
  ): Promise<{ rows: Record<string, unknown>[] }> {
    // Use PGlite's transaction() rather than raw BEGIN/COMMIT via separate query()
    // calls: transaction() holds PGlite's transaction lock, so the SET LOCAL tuning
    // + SELECT run atomically. A CONCURRENT query on the single shared connection
    // (e.g. HybridSearchService runs this vector search and a plain FTS SELECT via
    // Promise.all) therefore cannot interleave INTO this transaction — which with
    // raw BEGIN/COMMIT would pull the FTS read inside this tx, inheriting its
    // snapshot and coupling their abort states.
    return await this.db.transaction(async (tx) => {
      for (const statement of hnswSearchTuningStatements(efSearch)) {
        await tx.query(statement);
      }
      const result = await tx.query<Record<string, unknown>>(searchSql, params);
      return { rows: result.rows };
    });
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
   *
   * @example
   * ```typescript
   * // Simple keyword search
   * const results = await repo.fullTextSearch('authentication error');
   *
   * // Websearch with OR and negation
   * const results = await repo.fullTextSearch('login OR signup -deprecated', {
   *   queryMode: 'websearch',
   *   limit: 20,
   * });
   *
   * // Exact phrase match
   * const results = await repo.fullTextSearch('user authentication flow', {
   *   queryMode: 'phrase',
   * });
   * ```
   */
  async fullTextSearch(query: string, options: FTSSearchOptions = {}): Promise<FTSSearchResult[]> {
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
      includeEmbedding = true,
      includeHeadline = true,
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
        ${includeEmbedding ? FILE_CHUNK_SELECT_COLUMNS : FILE_CHUNK_SELECT_COLUMNS_DIMS_ONLY},
        ts_rank(content_tsvector, ${tsqueryFunc}($1::regconfig, $2), ${rankNormalization}) as fts_rank,
        ${
          includeHeadline
            ? `ts_headline($1::regconfig, content, ${tsqueryFunc}($1::regconfig, $2),
          'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15') as headline,`
            : ''
        }
        ROW_NUMBER() OVER (ORDER BY ts_rank(content_tsvector, ${tsqueryFunc}($1::regconfig, $2), ${rankNormalization}) DESC) as position
      FROM file_chunks
      WHERE ${whereParts.join(' AND ')}
      ORDER BY fts_rank DESC
      LIMIT $${paramIndex}`,
      [...params, limit]
    );

    // Map results to FTSSearchResult
    const results: FTSSearchResult[] = [];
    for (const row of result.rows) {
      const ftsRow = row as FileChunkRow & { fts_rank: string; headline: string; position: string };
      const rank = Number.parseFloat(ftsRow.fts_rank);

      // Apply threshold filter
      if (threshold > 0 && rank < threshold) {
        continue;
      }

      const ftsResult: FTSSearchResult = {
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
   * Candidate selection for grep search: trigram-accelerated ILIKE/LIKE
   * prefilter (idx_file_chunks_content_trgm), or a bounded unfiltered scan
   * when likePattern is null. Joins file_records for the path so the grep
   * service can emit path:line results without a second lookup.
   *
   * filePaths is an allowlist: `undefined` means no path filter (all files),
   * while an EMPTY array means nothing is allowed and returns no candidates.
   * Allowlists larger than MAX_INLINE_FILE_PATHS throw (matching
   * fullTextSearch/searchSimilar).
   */
  async findGrepCandidates(options: GrepCandidateOptions): Promise<GrepCandidate[]> {
    const { likePattern, caseSensitive, embeddingSetId, filePaths, limit } = options;

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (likePattern !== null) {
      params.push(`%${likePattern}%`);
      const operator = caseSensitive ? 'LIKE' : 'ILIKE';
      conditions.push(`fc.content ${operator} $${params.length} ESCAPE '\\'`);
    }
    if (embeddingSetId !== undefined) {
      params.push(embeddingSetId);
      conditions.push(`fc.embedding_set_id = $${params.length}`);
    }
    if (filePaths !== undefined) {
      if (filePaths.length === 0) {
        return []; // empty allowlist = nothing allowed
      }
      if (filePaths.length > MAX_INLINE_FILE_PATHS) {
        throw new Error(
          `findGrepCandidates filePaths limit exceeded (${filePaths.length} > ${MAX_INLINE_FILE_PATHS}).`
        );
      }
      params.push(Array.from(filePaths));
      conditions.push(`fr.path = ANY($${params.length}::text[])`);
    }
    params.push(limit);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.db.query(
      `SELECT fc.content, fc.start_line, fr.path
         FROM file_chunks fc
         JOIN file_records fr ON fr.id = fc.file_record_id
         ${whereClause}
        ORDER BY fr.path, fc.chunk_index
        LIMIT $${params.length}`,
      params
    );

    return (result.rows as Array<{ content: string; path: string; start_line: number | null }>).map(
      (row) => ({
        content: row.content,
        filePath: row.path,
        startLine: row.start_line,
      })
    );
  }

  /**
   * Get the PostgreSQL tsquery function for the given query mode
   */
  private getTsqueryFunction(mode: FTSQueryMode): string {
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
      `SELECT ${FILE_CHUNK_SELECT_COLUMNS} FROM file_chunks ORDER BY created_at DESC`
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

  /**
   * Coverage for a specific embedding set.
   * Returns counts for all chunks and chunks that have embeddings for the given set id.
   */
  async getCoverageForSet(embeddingSetId: string): Promise<{
    totalChunks: number;
    chunksWithEmbeddingsForSet: number;
  }> {
    if (!embeddingSetId) {
      throw new Error('embeddingSetId is required');
    }
    const result = await this.db.query<{
      chunksWithEmbeddingsForSet: string | null;
      totalChunks: string | null;
    }>(
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
    const row = result.rows[0];
    return {
      totalChunks: Number(row?.totalChunks ?? 0),
      chunksWithEmbeddingsForSet: Number(row?.chunksWithEmbeddingsForSet ?? 0),
    };
  }

  /**
   * Clears all embeddings for a specific embedding set without deleting the chunks.
   * This enables the re-embed workflow: clear old embeddings, then backfill with new model.
   *
   * @param embeddingSetId - The embedding set ID whose embeddings should be cleared
   * @returns Number of chunks that had their embeddings cleared
   */
  async clearEmbeddingsForSet(embeddingSetId: string): Promise<number> {
    if (!embeddingSetId) {
      throw new Error('embeddingSetId is required');
    }

    const result = await this.db.query<{ clearedCount: number | string }>(
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

    return Number(result.rows[0]?.clearedCount ?? 0);
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
  ): Promise<{ similarityExpr: string; orderExpr: string; dimension: number }> {
    const setRes = await this.db.query<{ distance: string; dimensions?: number }>(
      'SELECT distance, dimensions FROM embedding_sets WHERE id = $1',
      [embeddingSetId]
    );
    const setRow = setRes.rows[0];
    if (!setRow) {
      throw new Error(`Embedding set ${embeddingSetId} not found.`);
    }
    const expectedDimension = Number(setRow.dimensions ?? Number.NaN);
    // Must be a positive INTEGER: it is string-interpolated into `halfvec(N)` and
    // `vector_dims(embedding) = N`, so a non-integer (e.g. 768.5) would emit invalid
    // SQL rather than fail with a clear error (#1141 review). Defense-in-depth —
    // `embedding_sets.dimensions` is an integer column.
    if (!Number.isInteger(expectedDimension) || expectedDimension <= 0) {
      throw new Error(`Embedding set ${embeddingSetId} has invalid dimension metadata.`);
    }
    if (queryEmbedding.length !== expectedDimension) {
      throw new Error(
        `Query embedding dimension mismatch: received ${queryEmbedding.length}, expected ${expectedDimension} for embedding set ${embeddingSetId}.`
      );
    }

    const distance = (setRow.distance || 'cosine') as 'cosine' | 'l2' | 'ip';
    const expressions = this.buildDistanceExpressions(distance, expectedDimension);
    return { ...expressions, dimension: expectedDimension };
  }

  /**
   * Build distance expressions for similarity search.
   * CRITICAL: The embedding column is cast to halfvec(dimension) to match the
   * half-precision partial HNSW index expression `(embedding::halfvec(N))`.
   * Without this cast, the query planner cannot use the dimension-specific indexes.
   */
  private buildDistanceExpressions(
    distance: 'cosine' | 'l2' | 'ip',
    dimension: number
  ): {
    similarityExpr: string;
    orderExpr: string;
  } {
    // Cast embedding (and the query param) to fixed-dimension halfvec so the
    // ORDER BY matches the half-precision HNSW partial index built by the
    // dimension-index-helpers. The full-precision vector stays in the COLUMN, but
    // BOTH the ANN ranking (orderExpr) AND the returned similarity score
    // (similarityExpr, also used for the `>= threshold` filter) are computed in fp16
    // here. Intentional: keeping the score on the same halfvec cast as the rank keeps
    // the returned score monotonic with the result order. Computing similarityExpr on
    // full-precision `vector` would give exact scores but could desync them from the
    // halfvec rank; the fp16 quantization error (~3 sig digits) is negligible for
    // thresholding/display.
    const embeddingCast = `(embedding::halfvec(${dimension}))`;
    const paramCast = `$1::halfvec(${dimension})`;

    if (distance === 'l2') {
      return {
        similarityExpr: `(1.0 / (1.0 + (${embeddingCast} <-> ${paramCast})))`,
        orderExpr: `${embeddingCast} <-> ${paramCast}`,
      };
    }
    if (distance === 'ip') {
      return {
        similarityExpr: `(1.0 / (1.0 + exp(+(${embeddingCast} <#> ${paramCast}))))`,
        orderExpr: `${embeddingCast} <#> ${paramCast}`,
      };
    }
    return {
      similarityExpr: `(1 - ((${embeddingCast} <=> ${paramCast}) / 2.0))`,
      orderExpr: `${embeddingCast} <=> ${paramCast}`,
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
      // content_tsvector is a STORED generated column; Postgres recomputes it
      // automatically when `content` changes, so we must not set it here.
      appendColumn(builder, 'content', chunk.content);
    }

    const simpleFields: [unknown, string][] = [
      [chunk.contentHash, 'content_hash'],
      [chunk.tokenCount, 'token_count'],
      [chunk.chunkType, 'chunk_type'],
      [chunk.chunkSize, 'chunk_size'],
      [chunk.startLine, 'start_line'],
      [chunk.endLine, 'end_line'],
      [chunk.startOffset, 'start_offset'],
      [chunk.endOffset, 'end_offset'],
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
    const embeddingDimensions = resolveEmbeddingDimensions(embedding, row.embedding_dims);
    return {
      id: row.id,
      fileRecordId: row.file_record_id,
      chunkIndex: row.chunk_index,
      content: row.content,
      contentHash: row.content_hash,
      tokenCount: row.token_count,
      chunkType: row.chunk_type,
      chunkSize: row.chunk_size,
      ...(row.start_line !== null && row.start_line !== undefined && { startLine: row.start_line }),
      ...(row.end_line !== null && row.end_line !== undefined && { endLine: row.end_line }),
      ...(row.start_offset !== null &&
        row.start_offset !== undefined && { startOffset: row.start_offset }),
      ...(row.end_offset !== null && row.end_offset !== undefined && { endOffset: row.end_offset }),
      ...(embedding && { embedding }),
      ...(embeddingDimensions !== undefined && { embeddingDimensions }),
      ...(row.embedding_set_id !== null && { embeddingSetId: row.embedding_set_id }),
      ...(row.embedding_updated_at !== null && { embeddingUpdatedAt: row.embedding_updated_at }),
      ...(row.embedding_hash !== null && { embeddingHash: row.embedding_hash }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
