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
  assertTextContentHasNoNullBytes,
  assertTextContentsHaveNoNullBytes,
} from '../text-content-invariants.js';
import {
  appendColumn,
  appendColumnIfDefined,
  batchArray,
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
  type UpdateBuilder,
  validateEmbeddingDimensions,
} from './_shared.js';

export interface FileChunkQueryTx {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
}

/**
 * Minimal transactional query surface used by FileChunkRepository.
 * Both PGlite and the desktop RemoteDbClient satisfy this structurally, so
 * assistant-server tools can pass `getDatabase()` without cast chains.
 */
export interface FileChunkDatabase extends FileChunkQueryTx {
  transaction: <T>(fn: (tx: FileChunkQueryTx) => Promise<T>) => Promise<T>;
}

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

// Type for stats query rows
interface FileChunkStatsRow {
  average_token_count: string;
  chunk_type: string;
  chunks_with_embeddings: string;
  total_chunks: string;
  type_count: string;
}

export class FileChunkRepository {
  constructor(private readonly db: FileChunkDatabase) {}

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
    assertTextContentsHaveNoNullBytes(chunks, (chunk) => chunk.content, 'File chunk content');

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

  async insertManyWithTx(tx: FileChunkQueryTx, chunks: FileChunkInsert[]): Promise<FileChunk[]> {
    if (chunks.length === 0) {
      return [];
    }
    assertTextContentsHaveNoNullBytes(chunks, (chunk) => chunk.content, 'File chunk content');

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
      rootId,
      rootIds,
      selectionSnapshotId,
      includeEmbedding = false,
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

    const { similarityExpr, orderExpr } = this.buildDistanceExpressions(
      distance,
      dimension,
      route === 'exact' ? 'exact' : 'halfvec'
    );

    const vectorParam = `[${queryEmbedding.join(',')}]`;
    // `vector_dims(embedding) = N` matches the partial HNSW index predicate on
    // the ANN route, and on the exact route guards the fixed-dimension
    // `$1::vector(N)` operator against rows of other dimensions.
    const whereParts = [
      'embedding IS NOT NULL',
      `vector_dims(embedding) = ${dimension}`,
      ...searchScope.clauses,
    ];
    const params: unknown[] = [vectorParam, ...searchScope.values];

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
      LIMIT $${params.length + 1}`;
    const searchParams = [...params, overfetchLimit];

    // ANN route: run the HNSW tuning and the search inside ONE transaction.
    // `SET LOCAL` only takes effect within a transaction block, so issuing it
    // autocommit (as the previous code did) was a silent no-op. The tuning
    // widens `hnsw.ef_search` and enables iterative scans so heavily filtered
    // searches keep walking the index until enough rows survive the WHERE
    // clause instead of under-returning.
    // Exact route: the full-precision order expression cannot match the
    // halfvec expression index, so the planner exact-scans the filtered
    // subset — no tuning (or transaction) needed.
    const result =
      route === 'exact'
        ? await this.db.query<Record<string, unknown>>(searchSql, searchParams)
        : await this.runVectorSearchInTransaction(searchSql, searchParams, efSearch);

    const mapped = result.rows.map((row) => {
      const searchRow = row as unknown as FileChunkSearchRow;
      const sim = Number.parseFloat(searchRow.similarity);
      return {
        chunk: this.mapRowToChunk(searchRow),
        rank: Number.parseInt(searchRow.rank, 10),
        similarity: sim,
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
   * keyword-based MATCHING, ordered by BM25 relevance (pg_textsearch,
   * migration 053; rank = negated BM25 score, higher = better). Supports
   * multiple query modes:
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
    if (rootIds !== undefined) {
      whereParts.push(
        `file_record_id IN (SELECT id FROM file_records WHERE root_id = ANY($${paramIndex}::text[]))`
      );
      params.push(Array.from(rootIds));
      paramIndex += 1;
    }

    // Execute search query ranked by BM25 (pg_textsearch, migration 053):
    // matching stays tsvector-based above, so query-mode semantics are
    // unchanged; only the ORDERING comes from BM25. The `, id` tiebreaks keep
    // ordering deterministic — BM25 produces exact score ties for rows with
    // identical term statistics.
    const result = await this.db.query(
      `SELECT
        ${includeEmbedding ? FILE_CHUNK_SELECT_COLUMNS : FILE_CHUNK_SELECT_COLUMNS_DIMS_ONLY},
        ${bm25RankExpression('$2')} as fts_rank,
        ${
          includeHeadline
            ? `ts_headline($1::regconfig, content, ${tsqueryFunc}($1::regconfig, $2),
          'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15') as headline,`
            : ''
        }
        ROW_NUMBER() OVER (ORDER BY ${bm25RankExpression('$2')} DESC, id) as position
      FROM file_chunks
      WHERE ${whereParts.join(' AND ')}
      ORDER BY fts_rank DESC, id
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
        position: Number.parseInt(ftsRow.position, 10),
        rank,
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
    const { likePattern, caseSensitive, embeddingSetId, filePaths, limit, rootId, rootIds } =
      options;

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
    if (rootId !== undefined) {
      params.push(rootId);
      conditions.push(`fr.root_id = $${params.length}`);
    }
    if (rootIds !== undefined) {
      if (rootIds.length === 0) {
        return []; // empty allowlist = nothing allowed (mirror filePaths semantics)
      }
      params.push(Array.from(rootIds));
      conditions.push(`fr.root_id = ANY($${params.length}::text[])`);
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
    // LEFT JOIN roots so legacy/unrooted files (root_id NULL) still appear; the
    // root id + display name travel with every candidate so matches stay
    // unambiguous across workspace roots that share a relative path.
    const result = await this.db.query(
      `SELECT fc.id AS chunk_id, fc.content, fc.start_line, fc.end_line, fr.path, fr.root_id, r.display_name
         FROM file_chunks fc
         JOIN file_records fr ON fr.id = fc.file_record_id
         LEFT JOIN roots r ON r.id = fr.root_id
         ${whereClause}
        ORDER BY fr.path, fc.chunk_index
        LIMIT $${params.length}`,
      params
    );

    return (
      result.rows as Array<{
        chunk_id: string;
        content: string;
        end_line: number | null;
        path: string;
        root_id: string | null;
        display_name: string | null;
        start_line: number | null;
      }>
    ).map((row) => ({
      chunkId: row.chunk_id,
      content: row.content,
      endLine: row.end_line,
      filePath: row.path,
      rootId: row.root_id,
      rootName: row.display_name,
      startLine: row.start_line,
    }));
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
      chunksWithEmbeddingsForSet: Number(row?.chunksWithEmbeddingsForSet ?? 0),
      totalChunks: Number(row?.totalChunks ?? 0),
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
    const clauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = startIndex;
    paramIndex = this.appendFilterClause(
      clauses,
      values,
      paramIndex,
      scope.fileRecordId,
      'file_record_id'
    );
    paramIndex = this.appendFilterClause(
      clauses,
      values,
      paramIndex,
      scope.chunkType,
      'chunk_type'
    );
    paramIndex = this.appendSelectionFilters(
      clauses,
      values,
      paramIndex,
      scope.filePaths,
      scope.selectionSnapshotId
    );
    // Scope to workspace roots via a subquery (not a JOIN) so the main
    // file_chunks predicate still matches the partial HNSW index.
    if (scope.rootId !== undefined) {
      clauses.push(
        `file_record_id IN (SELECT id FROM file_records WHERE root_id = $${paramIndex})`
      );
      values.push(scope.rootId);
      paramIndex += 1;
    }
    if (scope.rootIds !== undefined) {
      clauses.push(
        `file_record_id IN (SELECT id FROM file_records WHERE root_id = ANY($${paramIndex}::text[]))`
      );
      values.push(Array.from(scope.rootIds));
      paramIndex += 1;
    }
    const narrowed = clauses.length > 0;
    clauses.push(`embedding_set_id = $${paramIndex}`);
    values.push(scope.embeddingSetId);
    return { clauses, narrowed, values };
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
    const result = await this.db.query<{ c: number | string }>(
      `SELECT COUNT(*)::int AS c FROM (SELECT 1 FROM file_chunks WHERE ${whereParts.join(' AND ')} LIMIT ${boundedCap}) t`,
      values
    );
    return Number(result.rows[0]?.c ?? 0);
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
  ): Promise<{ distance: 'cosine' | 'l2' | 'ip'; dimension: number }> {
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
    return { dimension: expectedDimension, distance };
  }

  /**
   * Build distance expressions for similarity search.
   * CRITICAL ('halfvec' precision, the ANN route): the embedding column is cast
   * to halfvec(dimension) to match the half-precision partial HNSW index
   * expression `(embedding::halfvec(N))`. Without this cast, the query planner
   * cannot use the dimension-specific indexes.
   * 'exact' precision (the selective-filter route) is the mirror-image
   * guarantee: full-precision `embedding <=> $1::vector(N)` CANNOT match that
   * index expression, so the planner must exact-scan the filtered subset —
   * 100% recall by construction, with fp32 similarity scores.
   */
  private buildDistanceExpressions(
    distance: 'cosine' | 'l2' | 'ip',
    dimension: number,
    precision: 'exact' | 'halfvec' = 'halfvec'
  ): {
    similarityExpr: string;
    orderExpr: string;
  } {
    // halfvec: cast embedding (and the query param) to fixed-dimension halfvec so
    // the ORDER BY matches the half-precision HNSW partial index built by the
    // dimension-index-helpers. The full-precision vector stays in the COLUMN, but
    // BOTH the ANN ranking (orderExpr) AND the returned similarity score
    // (similarityExpr, also used for the `>= threshold` filter) are computed in fp16
    // here. Intentional: keeping the score on the same halfvec cast as the rank keeps
    // the returned score monotonic with the result order. Computing similarityExpr on
    // full-precision `vector` would give exact scores but could desync them from the
    // halfvec rank; the fp16 quantization error (~3 sig digits) is negligible for
    // thresholding/display.
    const embeddingCast =
      precision === 'exact' ? 'embedding' : `(embedding::halfvec(${dimension}))`;
    const paramCast =
      precision === 'exact' ? `$1::vector(${dimension})` : `$1::halfvec(${dimension})`;

    if (distance === 'l2') {
      return {
        orderExpr: `${embeddingCast} <-> ${paramCast}`,
        similarityExpr: `(1.0 / (1.0 + (${embeddingCast} <-> ${paramCast})))`,
      };
    }
    if (distance === 'ip') {
      return {
        orderExpr: `${embeddingCast} <#> ${paramCast}`,
        similarityExpr: `(1.0 / (1.0 + exp(+(${embeddingCast} <#> ${paramCast}))))`,
      };
    }
    return {
      orderExpr: `${embeddingCast} <=> ${paramCast}`,
      similarityExpr: `(1 - ((${embeddingCast} <=> ${paramCast}) / 2.0))`,
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
