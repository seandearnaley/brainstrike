import { runAtomicStatements } from '../atomic-transaction.js';
import type {
  ChunkSearchOptions,
  ChunkSearchResult,
  FileChunk,
  FileChunkInsert,
  FileChunkUpdate,
} from '../models/file-chunk';
import type { GrepCandidate, GrepCandidateOptions } from '../models/grep.js';
import {
  assertTextContentHasNoNullBytes,
  assertTextContentsHaveNoNullBytes,
} from '../text-content-invariants.js';
import {
  appendColumn,
  appendColumnIfDefined,
  assertFuzzyThreshold,
  bm25RankExpression,
  computeOverfetchLimit,
  createUpdateBuilder,
  FILE_CHUNK_SELECT_COLUMNS,
  FILE_CHUNK_SELECT_COLUMNS_DIMS_ONLY,
  type FilteredVectorSearchRoute,
  hnswSearchTuningStatements,
  MAX_INLINE_FILE_PATHS,
  parseEmbeddingLoose,
  type Queryable,
  resolveEmbeddingDimensions,
  resolveFilteredVectorSearchRoute,
  shouldUseFuzzyFallback,
  type UpdateBuilder,
  validateEmbeddingDimensions,
} from './_shared.js';
import type { ElectronDbAPI } from './electron-file-record-repository';
import {
  buildChunkDistanceExpressions,
  buildRawFullTextScopePlan,
  buildRawVectorScopePlan,
  mapFullTextSearchRows,
  mapVectorSearchRows,
  normalizeChunkSearchScope,
  tsqueryFunctionForMode,
} from './file-chunk-search-policy.js';
import { runFindGrepCandidatesQuery, runInsertManyWithTx } from './file-chunk-shared-queries.js';

// Type definition for database row returned by Electron IPC
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

/** Scoping filters of a similarity search, reusable across the search SQL and
 * the bounded selectivity counts (which need their own parameter numbering). */
interface SearchScope {
  chunkType?: string | undefined;
  embeddingSetId: string;
  filePaths?: string[] | undefined;
  fileRecordId?: string | undefined;
  rootId?: string | undefined;
  rootIds?: readonly string[] | undefined;
  selectionSnapshotId?: string | undefined;
}

function requireAtomicFuzzyTransaction(
  db: ElectronDbAPI
): NonNullable<ElectronDbAPI['transaction']> {
  if (!db.transaction) {
    throw new Error(
      'Electron fuzzy full-text search requires the atomic database transaction capability.'
    );
  }
  return db.transaction.bind(db);
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
    return runFindGrepCandidatesQuery((sql, params) => this.db.query(sql, params), options);
  }

  async insert(chunk: FileChunkInsert): Promise<FileChunk> {
    assertTextContentHasNoNullBytes(chunk.content, 'File chunk content');
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
    // Pinned contract: reject invalid content BEFORE opening the transaction
    // (the shared body re-asserts harmlessly inside).
    assertTextContentsHaveNoNullBytes(chunks, (chunk) => chunk.content, 'File chunk content');
    await this.db.query('BEGIN');
    try {
      const results = await runInsertManyWithTx(
        (sql, params) => this.db.query(sql, params),
        chunks,
        (row) => this.mapRowToChunk(row as FileChunkRow)
      );
      await this.db.query('COMMIT');
      return results;
    } catch (error) {
      await this.db.query('ROLLBACK');
      throw error;
    }
  }

  async insertManyWithTx(
    tx: Pick<ElectronDbAPI, 'query'>,
    chunks: FileChunkInsert[]
  ): Promise<FileChunk[]> {
    return runInsertManyWithTx(
      (sql, params) => tx.query(sql, params),
      chunks,
      (row) => this.mapRowToChunk(row as FileChunkRow)
    );
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
      rootId,
      rootIds,
      selectionSnapshotId,
      includeEmbedding = false,
    } = options;

    if (!embeddingSetId) {
      throw new Error(
        'searchSimilar SQL path requires embeddingSetId to avoid dimension mismatches'
      );
    }

    const { filePaths: normalizedFilePaths, selectionSnapshotId: normalizedSnapshotId } =
      normalizeChunkSearchScope({ filePaths, selectionSnapshotId });
    if (normalizedFilePaths && normalizedFilePaths.length > MAX_INLINE_FILE_PATHS) {
      throw new Error(
        `searchSimilar filePaths limit exceeded (${normalizedFilePaths.length} > ${MAX_INLINE_FILE_PATHS}). ` +
          'Use selectionSnapshotId for large selections.'
      );
    }

    const { distance, dimension } = await this.resolveDistanceConfig(
      embeddingSetId,
      queryEmbedding
    );

    const scope: SearchScope = {
      chunkType,
      embeddingSetId,
      filePaths: normalizedFilePaths,
      fileRecordId,
      rootId,
      rootIds,
      selectionSnapshotId: normalizedSnapshotId,
    };
    // Search params start at $2 ($1 is the query vector).
    const searchScope = this.buildScopeFilters(2, scope);

    // Narrowed searches (any filter beyond embedding_set_id) route adaptively:
    // the partial halfvec HNSW index collapses on selective filters (39.5%
    // recall@10 at 100k chunks with a ~10% filter — see _shared.ts), so bounded
    // selectivity counts pick between the tuned ANN path and an exact
    // full-precision scan of the filtered subset. Un-narrowed whole-set
    // searches (the dominant, fast query) skip the counts entirely.
    let route: FilteredVectorSearchRoute = 'ann';
    if (searchScope.narrowed) {
      route = await this.resolveNarrowedSearchRoute(scope);
      if (route === 'empty') {
        return [];
      }
    }

    const { similarityExpr, orderExpr } = buildChunkDistanceExpressions(
      distance,
      dimension,
      route === 'exact' ? 'exact' : 'halfvec'
    );

    const vectorParam = `[${queryEmbedding.join(',')}]`;
    // `vector_dims(embedding) = N` is required (with the halfvec column cast in
    // orderExpr) for the planner to use the partial half-precision HNSW index
    // (#1141); on the exact route it guards the fixed-dimension `$1::vector(N)`
    // operator against rows of other dimensions.
    const whereParts = [
      'embedding IS NOT NULL',
      `vector_dims(embedding) = ${dimension}`,
      ...searchScope.clauses,
    ];
    const params: unknown[] = [vectorParam, ...searchScope.values];

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
      LIMIT $${params.length + 1}`;
    // ANN route: run the HNSW tuning and the search in ONE transaction so
    // `SET LOCAL` applies to the SELECT (autocommit `SET LOCAL` is a silent
    // no-op). Iterative scans + a wider ef_search keep heavily filtered
    // searches from under-returning.
    // Exact route: the full-precision order expression cannot match the
    // halfvec expression index, so the planner exact-scans the filtered
    // subset — no tuning (or transaction) needed.
    const result =
      route === 'exact'
        ? await this.db.query(searchSql, [...params, overfetchLimit])
        : await this.runVectorSearchInTransaction(searchSql, [...params, overfetchLimit], efSearch);

    return mapVectorSearchRows(
      result.rows as unknown as FileChunkSearchRow[],
      (row) => this.mapRowToChunk(row),
      threshold,
      limit
    );
  }

  /**
   * Run a pgvector ANN search with HNSW tuning applied via `SET LOCAL` inside a
   * single transaction. `SET LOCAL` only affects the current transaction, so the
   * SELECT must run in the same transaction as the tuning statements. Read-only.
   *
   * Prefers the atomic IPC `transaction(statements, resultIndex)` primitive (#1141):
   * it runs the tuning + SELECT inside ONE `pglite.transaction()` in the main process,
   * whose connection lock serializes a concurrent FTS `query()` from
   * HybridSearchService's `Promise.all` — restoring isolation and breaking the
   * error-coupling that the raw BEGIN/COMMIT path leaves open. Falls back to raw
   * BEGIN/COMMIT only when the IPC db doesn't expose `transaction` (older/mocked APIs).
   */
  private async runVectorSearchInTransaction(
    searchSql: string,
    params: unknown[],
    efSearch?: number
  ): Promise<{ rows: Record<string, unknown>[] }> {
    const tuning = hnswSearchTuningStatements(efSearch).map((sql) => ({ sql }));
    const statements = [...tuning, { params, sql: searchSql }];
    const resultIndex = statements.length - 1;

    const atomicTransport = this.db.transaction
      ? { runTransaction: this.db.transaction.bind(this.db) }
      : {};
    const result = await runAtomicStatements(
      atomicTransport,
      statements,
      resultIndex,
      'Electron ANN search requires atomic database transaction support.'
    );
    return { rows: result.rows as Record<string, unknown>[] };
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
      embeddingSetId,
      fileRecordId,
      chunkType,
      filePaths,
      fuzzyFallback = true,
      fuzzyThreshold = 0.6,
      rootIds,
      selectionSnapshotId,
      queryMode = 'websearch',
      language = 'english',
      includeEmbedding = false,
      includeHeadline = true,
    } = options;

    // Validate query
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return [];
    }
    assertFuzzyThreshold(fuzzyThreshold);

    const { filePaths: normalizedFilePaths, selectionSnapshotId: normalizedSnapshotId } =
      normalizeChunkSearchScope({ filePaths, selectionSnapshotId });
    if (normalizedFilePaths && normalizedFilePaths.length > MAX_INLINE_FILE_PATHS) {
      throw new Error(
        `fullTextSearch filePaths limit exceeded (${normalizedFilePaths.length} > ${MAX_INLINE_FILE_PATHS}). ` +
          'Use selectionSnapshotId for large selections.'
      );
    }

    // Build tsquery using the appropriate function based on query mode
    const tsqueryFunc = tsqueryFunctionForMode(queryMode);
    const scopePlan = buildRawFullTextScopePlan(3, {
      chunkType,
      embeddingSetId,
      filePaths: normalizedFilePaths,
      fileRecordId,
      rootIds,
      selectionSnapshotId: normalizedSnapshotId,
    });
    const params: unknown[] = [trimmedQuery, language, ...scopePlan.values];
    const scopeWhereParts = scopePlan.clauses;
    const paramIndex = params.length + 1;

    // Execute search query ranked by BM25 (pg_textsearch, migration 066):
    // matching stays tsvector-based above, so query-mode semantics are
    // unchanged; only the ORDERING comes from BM25. The `, id` tiebreaks keep
    // ordering deterministic — BM25 produces exact score ties for rows with
    // identical term statistics.
    const exactWhereParts = [
      'content_tsvector IS NOT NULL',
      `content_tsvector @@ ${tsqueryFunc}($2::regconfig, $1)`,
      ...scopeWhereParts,
    ];
    const exactResult = await this.db.query(
      `SELECT
        ${includeEmbedding ? FILE_CHUNK_SELECT_COLUMNS : FILE_CHUNK_SELECT_COLUMNS_DIMS_ONLY},
        ${bm25RankExpression('$1')} as fts_rank,
        ${
          includeHeadline
            ? `ts_headline($2::regconfig, content, ${tsqueryFunc}($2::regconfig, $1),
          'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15') as headline,`
            : ''
        }
        ROW_NUMBER() OVER (ORDER BY ${bm25RankExpression('$1')} DESC, id) as position
      FROM file_chunks
      WHERE ${exactWhereParts.join(' AND ')}
      ORDER BY fts_rank DESC, id
      LIMIT $${paramIndex}`,
      [...params, limit]
    );

    const useFuzzyFallback = shouldUseFuzzyFallback({
      exactResultCount: exactResult.rows.length,
      fuzzyFallback,
      language,
      queryMode,
    });
    let rows = exactResult.rows;
    let matchKind: import('../models/file-chunk').FTSSearchResult['matchKind'] = 'exact';
    if (useFuzzyFallback) {
      const transaction = requireAtomicFuzzyTransaction(this.db);
      const fuzzyThresholdIndex = paramIndex;
      const fuzzySql = `SELECT
          ${includeEmbedding ? FILE_CHUNK_SELECT_COLUMNS : FILE_CHUNK_SELECT_COLUMNS_DIMS_ONLY},
          word_similarity($1, content)::float8 as fts_rank,
          ROW_NUMBER() OVER (ORDER BY word_similarity($1, content) DESC, id) as position
        FROM file_chunks
        WHERE $1 <% content
          AND word_similarity($1, content) >= $${fuzzyThresholdIndex}::float8
          AND ${tsqueryFunc}($2::regconfig, $1)::text <> ''${
            scopeWhereParts.length > 0 ? ` AND ${scopeWhereParts.join(' AND ')}` : ''
          }
        ORDER BY fts_rank DESC, id
        LIMIT $${fuzzyThresholdIndex + 1}`;
      const fuzzyResult = await transaction(
        [
          {
            params: [String(fuzzyThreshold)],
            sql: "SELECT set_config('pg_trgm.word_similarity_threshold', $1, true)",
          },
          { params: [...params, fuzzyThreshold, limit], sql: fuzzySql },
        ],
        1
      );
      rows = fuzzyResult.rows;
      matchKind = 'fuzzy';
    }

    return mapFullTextSearchRows(
      rows as Array<FileChunkRow & { fts_rank: string; headline?: string; position: string }>,
      (row) => this.mapRowToChunk(row),
      matchKind,
      threshold
    );
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
      averageTokenCount: 0,
      chunksWithEmbeddings: 0,
      chunkTypeDistribution: {} as Record<string, number>,
      totalChunks: 0,
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
      chunksWithEmbeddingsForSet: Number(row?.chunksWithEmbeddingsForSet ?? 0),
      totalChunks: Number(row?.totalChunks ?? 0),
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

  /**
   * Materialize a search's scoping filters starting at `startIndex` ($1 is the
   * query vector in the search SQL, so it passes 2; the selectivity counts have
   * no vector parameter and pass 1). `narrowed` is true when any filter beyond
   * the mandatory `embedding_set_id` is present — only narrowed searches run
   * the adaptive-routing counts.
   */
  private buildScopeFilters(
    startIndex: number,
    scope: SearchScope
  ): { clauses: string[]; narrowed: boolean; values: unknown[] } {
    return buildRawVectorScopePlan(startIndex, scope);
  }

  /**
   * Route a NARROWED similarity search (exact filtered scan vs ANN) from two
   * bounded selectivity counts. See `resolveFilteredVectorSearchRoute` in
   * `_shared.ts` for the decision rule and the measured recall collapse it fixes.
   */
  private async resolveNarrowedSearchRoute(scope: SearchScope): Promise<FilteredVectorSearchRoute> {
    const countScope = this.buildScopeFilters(1, scope);
    return await resolveFilteredVectorSearchRoute(
      (cap) =>
        this.runBoundedCount(
          ['embedding IS NOT NULL', ...countScope.clauses],
          countScope.values,
          cap
        ),
      (cap) =>
        this.runBoundedCount(
          ['embedding IS NOT NULL', 'embedding_set_id = $1'],
          [scope.embeddingSetId],
          cap
        )
    );
  }

  /**
   * Count matching rows, stopping the scan once `cap` rows are seen. Cheap
   * predicates only — the callers deliberately omit `vector_dims(embedding)`
   * (it would detoast every candidate's vector just to route the query).
   */
  private async runBoundedCount(
    whereParts: string[],
    values: unknown[],
    cap: number
  ): Promise<number> {
    const boundedCap = Math.max(1, Math.floor(cap));
    const result = await this.db.query(
      `SELECT COUNT(*)::int AS c FROM (SELECT 1 FROM file_chunks WHERE ${whereParts.join(' AND ')} LIMIT ${boundedCap}) t`,
      values
    );
    const row = result.rows[0] as { c?: number | string } | undefined;
    return Number(row?.c ?? 0);
  }

  private async resolveDistanceConfig(
    embeddingSetId: string,
    queryEmbedding: number[]
  ): Promise<{ distance: 'cosine' | 'l2' | 'ip'; dimension: number }> {
    const setRes = await this.db.query(
      'SELECT distance, dimensions FROM embedding_sets WHERE id = $1',
      [embeddingSetId]
    );
    const setRow = setRes.rows[0] as { distance?: string; dimensions?: number } | undefined;
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
    return { dimension: expectedDimension, distance };
  }

  private async resolveExistingChunkForUpdate(chunk: FileChunkUpdate): Promise<FileChunk | null> {
    if (chunk.embedding !== undefined && !chunk.embeddingSetId) {
      return this.findById(chunk.id);
    }
    return null;
  }

  private appendSimpleUpdates(builder: UpdateBuilder, chunk: FileChunkUpdate): void {
    if (chunk.content !== undefined) {
      assertTextContentHasNoNullBytes(chunk.content, 'File chunk content');
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
      chunkIndex: row.chunk_index,
      chunkSize: row.chunk_size,
      chunkType: row.chunk_type,
      content: row.content,
      contentHash: row.content_hash,
      fileRecordId: row.file_record_id,
      id: row.id,
      tokenCount: row.token_count,
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
