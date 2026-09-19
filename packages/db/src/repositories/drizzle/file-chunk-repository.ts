import type { IFileChunkRepository } from '../interfaces.js';
/**
 * Drizzle-based FileChunk Repository
 *
 * This is the Drizzle ORM version of the FileChunkRepository.
 * Provides type-safe database operations for file chunks and embeddings.
 *
 * Note: Some advanced vector operations use raw SQL via Drizzle's execute()
 * since pgvector operators aren't natively supported by the query builder.
 */

import { count, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../drizzle/database.js';
import type {
  ChunkSearchOptions,
  ChunkSearchResult,
  FileChunk,
  FileChunkInsert,
  FileChunkUpdate,
} from '../../models/file-chunk.js';
import type { GrepCandidate, GrepCandidateOptions } from '../../models/grep';
import {
  embeddingSets,
  fileChunks,
  fileRecords,
  selectionSnapshotFiles,
} from '../../schema/index.js';
import {
  assertTextContentHasNoNullBytes,
  assertTextContentsHaveNoNullBytes,
} from '../../text-content-invariants.js';
import {
  assertFuzzyThreshold,
  BM25_CONTENT_INDEX_NAME,
  computeOverfetchLimit,
  FILE_CHUNK_SELECT_COLUMNS,
  FILE_CHUNK_SELECT_COLUMNS_DIMS_ONLY,
  type FilteredVectorSearchRoute,
  hnswSearchTuningStatements,
  MAX_INLINE_FILE_PATHS,
  resolveEmbeddingDimensions,
  resolveFilteredVectorSearchRoute,
  shouldUseFuzzyFallback,
} from '../_shared.js';
import type { FileChunkQueryTx } from '../file-chunk-repository.js';
import {
  buildChunkDistanceExpressions,
  mapFullTextSearchRows,
  mapVectorSearchRows,
  normalizeChunkSearchScope,
  tsqueryFunctionForMode,
} from '../file-chunk-search-policy.js';
import { runFindGrepCandidatesQuery, runInsertManyWithTx } from '../file-chunk-shared-queries.js';

/**
 * Maximum supported embedding dimension for pgvector.
 * This corresponds to pgvector's default max dimension (2^16 - 1).
 * Common production dimensions: 384 (MiniLM), 768 (BERT), 1536 (OpenAI), 3072 (OpenAI large).
 */
export const MAX_EMBEDDING_DIMENSION = 65_535;

/**
 * Validates that all elements in an embedding vector are finite numbers.
 * This is a defense-in-depth measure to prevent malformed data from being
 * interpolated into SQL queries.
 *
 * @throws Error if any element is not a finite number
 */
function validateEmbeddingVector(embedding: number[], context: string): void {
  for (let i = 0; i < embedding.length; i++) {
    const value = embedding[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${context}: Invalid embedding value at index ${i}: ${value}`);
    }
  }
}

/**
 * Maximum result limit a similarity search may request. Bounds renderer memory
 * for large fan-out reads.
 *
 * MUST stay >= the UI free-input ceiling (`RESULT_LIMIT_MAX` in `@brainstrike/ui`)
 * — the executor clamps requested limits to that ceiling and hybrid sizes its
 * source pools up to it, so a smaller cap here would make web search throw for
 * limits between the two. The cross-layer invariant is pinned by a test in
 * `@brainstrike/db-explorer` (result-limit-ceiling.test.ts).
 *
 * NOTE: this hard reject lives ONLY on this (Drizzle/web) path. The PGlite and
 * Electron repos deliberately do NOT replicate it — they bound work via the
 * shared `computeOverfetchLimit` cap (<=10k rows) instead, because they also
 * serve callers that legitimately set their own limit (e.g. the assistant RAG
 * retrieval tool passes its own topK straight to `FileChunkRepository`). The UI
 * search path is bounded on every platform by the executor's `clampResultLimit`;
 * this throw is an extra backstop for the web repo, not a cross-platform rule.
 */
export const MAX_SEARCH_RESULT_LIMIT = 2000;

/**
 * Safely constructs a pgvector literal string from an embedding array.
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ SECURITY BOUNDARY: SQL Injection Prevention for Vector Literals            │
 * ├─────────────────────────────────────────────────────────────────────────────┤
 * │ This function is a critical security boundary that prevents SQL injection  │
 * │ in pgvector similarity queries. The pgvector operators (<->, <=>, etc.)    │
 * │ require vector literals to be interpolated directly into SQL because       │
 * │ standard parameter binding doesn't work for pgvector's custom operators.   │
 * │                                                                            │
 * │ SECURITY GUARANTEES:                                                       │
 * │ 1. Input MUST be a JavaScript number array (enforced by TypeScript)        │
 * │ 2. Each element MUST be typeof 'number' (validated below)                  │
 * │ 3. Each element MUST be finite - no NaN, Infinity, -Infinity (validated)   │
 * │ 4. JavaScript finite numbers can only contain: digits, '.', '-', 'e', 'E'  │
 * │    These characters cannot form SQL injection payloads                     │
 * │ 5. Output format [n,n,n] is exactly what pgvector expects                  │
 * │                                                                            │
 * │ WHY sql.raw() IS SAFE HERE:                                                │
 * │ - The only data interpolated is JavaScript finite numbers                  │
 * │ - JavaScript Number.toString() cannot produce SQL metacharacters           │
 * │ - Array.join(',') only adds safe comma separators                          │
 * │ - Validation is inside this function, not a separate call that could be    │
 * │   bypassed during refactoring                                              │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * @param embedding - Array of numbers to convert
 * @returns pgvector literal string in format '[n1,n2,...]'
 * @throws Error if any element is not a finite number
 */
function toPgvectorLiteral(embedding: number[]): string {
  // Defense-in-depth: validate INSIDE this function to guarantee safety
  // even if upstream validation is bypassed or removed during refactoring
  for (let i = 0; i < embedding.length; i++) {
    const value = embedding[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(
        `toPgvectorLiteral: Invalid value at index ${i}: ${value} (must be finite number)`
      );
    }
  }
  return `[${embedding.join(',')}]`;
}

export class DrizzleFileChunkRepository implements IFileChunkRepository {
  constructor(private readonly db: DrizzleDb) {}

  async findById(id: string): Promise<FileChunk | null> {
    const [row] = await this.db.select().from(fileChunks).where(eq(fileChunks.id, id));
    return row ? this.fromRow(row) : null;
  }

  async findByFileRecordId(fileRecordId: string): Promise<FileChunk[]> {
    const rows = await this.db
      .select()
      .from(fileChunks)
      .where(eq(fileChunks.fileRecordId, fileRecordId))
      .orderBy(fileChunks.chunkIndex);
    return rows.map((row) => this.fromRow(row));
  }

  async insert(chunk: FileChunkInsert): Promise<FileChunk> {
    assertTextContentHasNoNullBytes(chunk.content, 'File chunk content');
    const [row] = await this.db
      .insert(fileChunks)
      .values({
        chunkIndex: chunk.chunkIndex,
        chunkSize: chunk.chunkSize ?? null,
        chunkType: chunk.chunkType ?? null,
        content: chunk.content,
        contentHash: chunk.contentHash ?? null,
        createdAt: new Date(chunk.createdAt),
        embedding: chunk.embedding ?? null,
        embeddingHash: chunk.embeddingHash ?? null,
        embeddingSetId: chunk.embeddingSetId ?? null,
        embeddingUpdatedAt: chunk.embeddingUpdatedAt ? new Date(chunk.embeddingUpdatedAt) : null,
        endLine: chunk.endLine ?? null,
        endOffset: chunk.endOffset ?? null,
        fileRecordId: chunk.fileRecordId,
        id: chunk.id,
        startLine: chunk.startLine ?? null,
        startOffset: chunk.startOffset ?? null,
        tokenCount: chunk.tokenCount ?? null,
        updatedAt: new Date(chunk.updatedAt),
      })
      .onConflictDoUpdate({
        set: {
          chunkSize: sql`excluded.chunk_size`,
          chunkType: sql`excluded.chunk_type`,
          content: sql`excluded.content`,
          contentHash: sql`excluded.content_hash`,
          embedding: sql`excluded.embedding`,
          embeddingHash: sql`excluded.embedding_hash`,
          embeddingSetId: sql`excluded.embedding_set_id`,
          embeddingUpdatedAt: sql`excluded.embedding_updated_at`,
          endLine: sql`excluded.end_line`,
          endOffset: sql`excluded.end_offset`,
          startLine: sql`excluded.start_line`,
          startOffset: sql`excluded.start_offset`,
          tokenCount: sql`excluded.token_count`,
          updatedAt: sql`excluded.updated_at`,
        },
        target: fileChunks.id,
      })
      .returning();

    if (!row) {
      throw new Error(`Failed to insert chunk ${chunk.id}`);
    }

    return this.fromRow(row);
  }

  async insertMany(chunks: FileChunkInsert[]): Promise<FileChunk[]> {
    if (chunks.length === 0) {
      return [];
    }
    assertTextContentsHaveNoNullBytes(chunks, (chunk) => chunk.content, 'File chunk content');

    const values = chunks.map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      chunkSize: chunk.chunkSize ?? null,
      chunkType: chunk.chunkType ?? null,
      content: chunk.content,
      contentHash: chunk.contentHash ?? null,
      createdAt: new Date(chunk.createdAt),
      embedding: chunk.embedding ?? null,
      embeddingHash: chunk.embeddingHash ?? null,
      embeddingSetId: chunk.embeddingSetId ?? null,
      embeddingUpdatedAt: chunk.embeddingUpdatedAt ? new Date(chunk.embeddingUpdatedAt) : null,
      endLine: chunk.endLine ?? null,
      endOffset: chunk.endOffset ?? null,
      fileRecordId: chunk.fileRecordId,
      id: chunk.id,
      startLine: chunk.startLine ?? null,
      startOffset: chunk.startOffset ?? null,
      tokenCount: chunk.tokenCount ?? null,
      updatedAt: new Date(chunk.updatedAt),
    }));

    const rows = await this.db
      .insert(fileChunks)
      .values(values)
      .onConflictDoUpdate({
        set: {
          chunkSize: sql`excluded.chunk_size`,
          chunkType: sql`excluded.chunk_type`,
          content: sql`excluded.content`,
          contentHash: sql`excluded.content_hash`,
          embedding: sql`excluded.embedding`,
          embeddingHash: sql`excluded.embedding_hash`,
          embeddingSetId: sql`excluded.embedding_set_id`,
          embeddingUpdatedAt: sql`excluded.embedding_updated_at`,
          endLine: sql`excluded.end_line`,
          endOffset: sql`excluded.end_offset`,
          startLine: sql`excluded.start_line`,
          startOffset: sql`excluded.start_offset`,
          tokenCount: sql`excluded.token_count`,
          updatedAt: sql`excluded.updated_at`,
        },
        target: fileChunks.id,
      })
      .returning();

    return rows.map((row) => this.fromRow(row));
  }

  async update(chunk: FileChunkUpdate): Promise<FileChunk | null> {
    const updateData: Partial<typeof fileChunks.$inferInsert> = {
      updatedAt: new Date(chunk.updatedAt),
    };

    if (chunk.content !== undefined) {
      assertTextContentHasNoNullBytes(chunk.content, 'File chunk content');
      // content_tsvector is a STORED generated column; Postgres recomputes it
      // automatically when `content` changes, so we must not set it here.
      updateData.content = chunk.content;
    }
    if (chunk.contentHash !== undefined) {
      updateData.contentHash = chunk.contentHash;
    }
    if (chunk.tokenCount !== undefined) {
      updateData.tokenCount = chunk.tokenCount;
    }
    if (chunk.chunkType !== undefined) {
      updateData.chunkType = chunk.chunkType;
    }
    if (chunk.chunkSize !== undefined) {
      updateData.chunkSize = chunk.chunkSize;
    }
    if (chunk.startLine !== undefined) {
      updateData.startLine = chunk.startLine;
    }
    if (chunk.endLine !== undefined) {
      updateData.endLine = chunk.endLine;
    }
    if (chunk.startOffset !== undefined) {
      updateData.startOffset = chunk.startOffset;
    }
    if (chunk.endOffset !== undefined) {
      updateData.endOffset = chunk.endOffset;
    }
    if (chunk.embedding !== undefined) {
      updateData.embedding = chunk.embedding;
      updateData.embeddingUpdatedAt = chunk.embeddingUpdatedAt
        ? new Date(chunk.embeddingUpdatedAt)
        : new Date(chunk.updatedAt);
    }
    if (chunk.embeddingSetId !== undefined) {
      updateData.embeddingSetId = chunk.embeddingSetId;
    }
    if (chunk.embeddingHash !== undefined) {
      updateData.embeddingHash = chunk.embeddingHash;
    }

    const [row] = await this.db
      .update(fileChunks)
      .set(updateData)
      .where(eq(fileChunks.id, chunk.id))
      .returning();

    return row ? this.fromRow(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(fileChunks).where(eq(fileChunks.id, id)).returning();
    return result.length > 0;
  }

  async deleteByFileRecordId(fileRecordId: string): Promise<number> {
    const result = await this.db
      .delete(fileChunks)
      .where(eq(fileChunks.fileRecordId, fileRecordId))
      .returning();
    return result.length;
  }

  async findAll(): Promise<FileChunk[]> {
    const rows = await this.db.select().from(fileChunks).orderBy(sql`${fileChunks.createdAt} DESC`);
    return rows.map((row) => this.fromRow(row));
  }

  /**
   * Vector similarity search using pgvector operators.
   * Uses raw SQL through Drizzle's execute() since pgvector operators
   * aren't natively supported by the query builder.
   */
  async searchSimilar(
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

    // Validate limit to prevent memory exhaustion from excessive requests
    if (limit > MAX_SEARCH_RESULT_LIMIT) {
      throw new Error(
        `searchSimilar limit ${limit} exceeds maximum allowed (${MAX_SEARCH_RESULT_LIMIT}). ` +
          'Use pagination for larger result sets.'
      );
    }

    if (!embeddingSetId) {
      throw new Error('searchSimilar requires embeddingSetId to avoid dimension mismatches');
    }

    const { filePaths: normalizedFilePaths, selectionSnapshotId: normalizedSnapshotId } =
      normalizeChunkSearchScope({ filePaths, selectionSnapshotId });
    if (normalizedFilePaths && normalizedFilePaths.length > MAX_INLINE_FILE_PATHS) {
      throw new Error(
        `searchSimilar filePaths limit exceeded (${normalizedFilePaths.length} > ${MAX_INLINE_FILE_PATHS}). ` +
          'Use selectionSnapshotId for large selections.'
      );
    }

    // Get embedding set config
    const [setRow] = await this.db
      .select()
      .from(embeddingSets)
      .where(eq(embeddingSets.id, embeddingSetId));

    if (!setRow) {
      throw new Error(`Embedding set ${embeddingSetId} not found.`);
    }

    const dimension = setRow.dimensions;
    if (queryEmbedding.length !== dimension) {
      throw new Error(
        `Query embedding dimension mismatch: received ${queryEmbedding.length}, expected ${dimension}`
      );
    }

    // Validate all embedding values are finite numbers (defense-in-depth)
    // This MUST be called before toPgvectorLiteral() for security
    validateEmbeddingVector(queryEmbedding, 'searchSimilar');

    const distance = setRow.distance || 'cosine';

    const scopeConditions = await this.buildSearchScopeConditions({
      chunkType,
      fileRecordId,
      normalizedFilePaths,
      normalizedSnapshotId,
      rootId,
      rootIds,
    });
    // An empty allowlist (rootIds / filePaths) matches nothing.
    if (scopeConditions === null) {
      return [];
    }

    // Narrowed searches (any filter beyond embedding_set_id) route adaptively:
    // the partial halfvec HNSW index collapses on selective filters (39.5%
    // recall@10 at 100k chunks with a ~10% filter — see _shared.ts), so bounded
    // selectivity counts pick between the tuned ANN path and an exact
    // full-precision scan of the filtered subset. Un-narrowed whole-set
    // searches (the dominant, fast query) skip the counts entirely.
    let route: FilteredVectorSearchRoute = 'ann';
    if (scopeConditions.length > 0) {
      route = await this.resolveNarrowedSearchRoute(embeddingSetId, scopeConditions);
      if (route === 'empty') {
        return [];
      }
    }

    const { similarityExpr, orderExpr } = buildChunkDistanceExpressions(
      distance as 'cosine' | 'l2' | 'ip',
      dimension,
      route === 'exact' ? 'exact' : 'halfvec',
      MAX_EMBEDDING_DIMENSION
    );

    // Convert validated embedding to pgvector literal format
    // Safe because validateEmbeddingVector guarantees all values are finite numbers
    const vectorLiteral = toPgvectorLiteral(queryEmbedding);

    // Overfetch to improve result quality, capped (shared with the other repos)
    // to prevent memory exhaustion with very large limit values.
    const overfetchLimit = computeOverfetchLimit(limit);

    // Build dynamic query with proper parameterization
    // Note: We use sql template tag for parameters, but still need raw for pgvector operators
    // The embeddingSetId, fileRecordId, and chunkType are parameterized via sql template
    // The vectorLiteral is safe because it was validated via validateEmbeddingVector()
    // Large fan-out reads can project the heavy embedding vector away (keeping
    // only its dimension count) — the distance math still runs in SQL.
    const selectColumns = includeEmbedding ? '*' : FILE_CHUNK_SELECT_COLUMNS_DIMS_ONLY;
    let baseQuery = sql`
      SELECT ${sql.raw(selectColumns)},
        ${sql.raw(similarityExpr.replace(/\$1/g, `'${vectorLiteral}'`))} as similarity,
        ROW_NUMBER() OVER (ORDER BY ${sql.raw(orderExpr.replace(/\$1/g, `'${vectorLiteral}'`))}) as rank
      FROM file_chunks
      WHERE embedding IS NOT NULL
        AND vector_dims(embedding) = ${dimension}
        AND embedding_set_id = ${embeddingSetId}
    `;
    for (const condition of scopeConditions) {
      baseQuery = sql`${baseQuery} AND ${condition}`;
    }

    baseQuery = sql`${baseQuery}
      ORDER BY ${sql.raw(orderExpr.replace(/\$1/g, `'${vectorLiteral}'`))}
      LIMIT ${overfetchLimit}
    `;

    // ANN route: run the HNSW tuning and the search in ONE transaction so
    // `SET LOCAL` applies to the SELECT (autocommit `SET LOCAL` is a silent
    // no-op). Iterative scans + a wider ef_search keep heavily filtered
    // searches from under-returning.
    // Exact route: the full-precision order expression cannot match the
    // halfvec expression index, so the planner exact-scans the filtered
    // subset — no tuning (or transaction) needed.
    const result =
      route === 'exact'
        ? await this.db.execute(baseQuery)
        : await this.db.transaction(async (tx) => {
            for (const statement of hnswSearchTuningStatements(efSearch)) {
              await tx.execute(sql.raw(statement));
            }
            return await tx.execute(baseQuery);
          });

    return mapVectorSearchRows(
      result.rows as Array<
        Record<string, unknown> & { rank: string | number; similarity: string | number }
      >,
      (row) => this.fromRawRow(row),
      threshold,
      limit
    );
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
    options: import('../../models/file-chunk.js').FTSSearchOptions = {}
  ): Promise<import('../../models/file-chunk.js').FTSSearchResult[]> {
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

    // Build WHERE clause dynamically
    const ftsColumns = includeEmbedding
      ? FILE_CHUNK_SELECT_COLUMNS
      : FILE_CHUNK_SELECT_COLUMNS_DIMS_ONLY;
    // ts_headline is costly per row; skip it when the caller won't render it.
    const headlineColumn = includeHeadline
      ? sql`ts_headline(${language}::regconfig, content, ${sql.raw(tsqueryFunc)}(${language}::regconfig, ${trimmedQuery}),
          'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15') as headline,`
      : sql``;
    // Ranked by BM25 (pg_textsearch, migration 066): matching stays
    // tsvector-based below, so query-mode semantics are unchanged; only the
    // ORDERING comes from BM25. The `, id` tiebreaks keep ordering
    // deterministic — BM25 produces exact score ties for rows with identical
    // term statistics.
    // BM25 orders but never matches: a row BM25 would score but the tsquery
    // rejects never reaches fusion, so recall is tsvector-bounded (BST-908).
    // NOTE: this is the drizzle-idiomatic form of `bm25RankExpression` from
    // ../_shared.ts (used by the raw-SQL repos): the index name rides as a
    // BOUND PARAMETER here instead of a SQL literal — semantically identical
    // to Postgres, and both spellings share BM25_CONTENT_INDEX_NAME so the
    // name cannot drift between the paths.
    const bm25Rank = sql`(-(content <@> to_bm25query(${trimmedQuery}, ${BM25_CONTENT_INDEX_NAME})))::float8`;
    const scopeConditions: SQL[] = [];

    if (fileRecordId) {
      scopeConditions.push(sql`file_record_id = ${fileRecordId}`);
    }
    if (chunkType) {
      scopeConditions.push(sql`chunk_type = ${chunkType}`);
    }
    // Embedding-set scope with coverage-identity semantics (getCoverageForSet):
    // the chunk's own set matches, OR the chunk is pending embedding (NULL set)
    // and its file record carries the set. Match (tsquery) semantics unchanged.
    // Mirrors the PGlite + Electron repos.
    if (embeddingSetId !== undefined) {
      scopeConditions.push(
        sql`(embedding_set_id = ${embeddingSetId} OR (embedding_set_id IS NULL AND file_record_id IN (SELECT id FROM file_records WHERE embedding_set_id = ${embeddingSetId})))`
      );
    }
    // Scope to a set of workspace roots (see searchSimilar above for the empty /
    // NULL-root semantics). Mirrors the PGlite + Electron repos.
    if (rootIds !== undefined) {
      const rootScopeCondition = this.rootScopedFileIdCondition(rootIds);
      if (rootScopeCondition === null) {
        return [];
      }
      scopeConditions.push(rootScopeCondition);
    }
    if (normalizedSnapshotId) {
      scopeConditions.push(sql`EXISTS (
        SELECT 1
        FROM ${selectionSnapshotFiles}
        JOIN ${fileRecords} ON ${fileRecords.path} = ${selectionSnapshotFiles.filePath}
        WHERE ${selectionSnapshotFiles.snapshotId} = ${normalizedSnapshotId}
          AND ${fileRecords.id} = ${fileChunks.fileRecordId}
      )`);
    }
    if (normalizedFilePaths && normalizedFilePaths.length > 0) {
      const rows = await this.db
        .select({ id: fileRecords.id })
        .from(fileRecords)
        .where(inArray(fileRecords.path, normalizedFilePaths));
      const fileRecordIds = rows.map((row) => row.id).filter(Boolean);
      if (fileRecordIds.length === 0) {
        return [];
      }
      scopeConditions.push(inArray(fileChunks.fileRecordId, fileRecordIds));
    }

    const applyScopeConditions = (baseQuery: SQL): SQL => {
      let scopedQuery = baseQuery;
      for (const condition of scopeConditions) {
        scopedQuery = sql`${scopedQuery} AND ${condition}`;
      }
      return scopedQuery;
    };

    let exactQuery = applyScopeConditions(sql`
      SELECT
        ${sql.raw(ftsColumns)},
        ${bm25Rank} as fts_rank,
        ${headlineColumn}
        ROW_NUMBER() OVER (ORDER BY ${bm25Rank} DESC, id) as position
      FROM file_chunks
      WHERE content_tsvector IS NOT NULL
        AND content_tsvector @@ ${sql.raw(tsqueryFunc)}(${language}::regconfig, ${trimmedQuery})
    `);
    exactQuery = sql`${exactQuery}
      ORDER BY fts_rank DESC, id
      LIMIT ${limit}
    `;

    const exactResult = await this.db.execute(exactQuery);
    const useFuzzyFallback = shouldUseFuzzyFallback({
      exactResultCount: exactResult.rows.length,
      fuzzyFallback,
      language,
      queryMode,
    });
    if (!useFuzzyFallback) {
      return this.mapFTSResults(exactResult.rows as Record<string, unknown>[], 'exact', threshold);
    }

    const fuzzyRank = sql`word_similarity(${trimmedQuery}, content)::float8`;
    let fuzzyQuery = applyScopeConditions(sql`
      SELECT
        ${sql.raw(ftsColumns)},
        ${fuzzyRank} as fts_rank,
        ROW_NUMBER() OVER (ORDER BY ${fuzzyRank} DESC, id) as position
      FROM file_chunks
      WHERE ${trimmedQuery} <% content
        AND word_similarity(${trimmedQuery}, content) >= ${fuzzyThreshold}
        AND ${sql.raw(tsqueryFunc)}(${language}::regconfig, ${trimmedQuery})::text <> ''
    `);
    fuzzyQuery = sql`${fuzzyQuery}
      ORDER BY fts_rank DESC, id
      LIMIT ${limit}
    `;
    const fuzzyResult = await this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(fuzzyThreshold)}, true)`
      );
      return transaction.execute(fuzzyQuery);
    });
    return this.mapFTSResults(fuzzyResult.rows as Record<string, unknown>[], 'fuzzy', threshold);
  }

  /**
   * Map raw FTS query results to FTSSearchResult objects
   */
  private mapFTSResults(
    rows: Record<string, unknown>[],
    matchKind: import('../../models/file-chunk.js').FTSSearchResult['matchKind'],
    threshold: number
  ): import('../../models/file-chunk.js').FTSSearchResult[] {
    return mapFullTextSearchRows(
      rows as Array<
        Record<string, unknown> & {
          fts_rank: string | number;
          headline?: string | null;
          position: string | number;
        }
      >,
      (row) => this.fromRawRow(row),
      matchKind,
      threshold
    );
  }
  /**
   * Build the `file_record_id ∈ (roots' files)` predicate for scoping a search
   * to `rootIds`. Returns `null` for an EMPTY allowlist (matches nothing — the
   * caller short-circuits to an empty result set), otherwise a subquery
   * predicate: `file_record_id IN (SELECT id FROM file_records WHERE root_id IN
   * (…))`. The subquery keeps the id set in SQL instead of materializing every
   * owned file id into a JS array and re-binding it (a large workspace would
   * round-trip thousands of ids per search). NULL-root legacy rows are never
   * matched (their root_id is not in the list). Mirrors the raw-SQL subqueries
   * the PGlite/Electron repos already use for the same scoping.
   */
  private rootScopedFileIdCondition(rootIds: readonly string[]): SQL | null {
    if (rootIds.length === 0) {
      return null;
    }
    return inArray(
      fileChunks.fileRecordId,
      this.db
        .select({ id: fileRecords.id })
        .from(fileRecords)
        .where(inArray(fileRecords.rootId, Array.from(rootIds)))
    );
  }

  async getStats(): Promise<{
    totalChunks: number;
    chunksWithEmbeddings: number;
    averageTokenCount: number;
    chunkTypeDistribution: Record<string, number>;
  }> {
    const [countResult] = await this.db.select({ count: count() }).from(fileChunks);
    const totalChunks = countResult?.count ?? 0;

    const result = await this.db.execute(sql`
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
      totalChunks,
    };

    let totalTokenSum = 0;
    let totalWithTokens = 0;

    for (const row of result.rows as Record<string, unknown>[]) {
      stats.chunksWithEmbeddings += Number(row['chunks_with_embeddings'] ?? 0);
      const typeCount = Number(row['type_count'] ?? 0);
      const chunkType = String(row['chunk_type'] ?? 'unknown');
      stats.chunkTypeDistribution[chunkType] = typeCount;

      const avgTokens = Number(row['average_token_count'] ?? 0);
      totalTokenSum += avgTokens * typeCount;
      totalWithTokens += typeCount;
    }

    if (totalWithTokens > 0) {
      stats.averageTokenCount = totalTokenSum / totalWithTokens;
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

    const [totalResult] = await this.db.select({ count: count() }).from(fileChunks);

    const result = await this.db.execute(sql`
      SELECT COUNT(*)::text as count
      FROM file_chunks
      WHERE embedding_set_id = ${embeddingSetId} AND embedding IS NOT NULL
    `);

    const countRow = (result.rows as Record<string, unknown>[])[0];

    return {
      chunksWithEmbeddingsForSet: Number(countRow?.['count'] ?? 0),
      totalChunks: totalResult?.count ?? 0,
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

    const result = await this.db.execute(sql`
      UPDATE file_chunks
      SET embedding = NULL,
          embedding_updated_at = NULL,
          embedding_hash = NULL,
          updated_at = NOW()
      WHERE embedding_set_id = ${embeddingSetId}
        AND embedding IS NOT NULL
      RETURNING id
    `);

    return (result.rows as unknown[]).length;
  }

  async clearAll(): Promise<number> {
    const [countResult] = await this.db.select({ count: count() }).from(fileChunks);
    const totalCount = countResult?.count ?? 0;

    await this.db.delete(fileChunks);
    return totalCount;
  }

  /**
   * Materialize a similarity search's scoping filters ONCE as composable SQL
   * fragments so the same predicates drive the adaptive-routing selectivity
   * counts AND the search itself (mirrors `buildScopeFilters` in the
   * PGlite/Electron repos). Returns `null` when an allowlist (rootIds /
   * filePaths) matches nothing — the caller short-circuits to []. Root scoping
   * uses a subquery predicate on `file_record_id` (not a JOIN) so the main
   * file_chunks predicate still matches the partial HNSW index; NULL-root
   * legacy rows are excluded.
   */
  private async buildSearchScopeConditions(scope: {
    chunkType: string | undefined;
    fileRecordId: string | undefined;
    normalizedFilePaths: string[] | undefined;
    normalizedSnapshotId: string | undefined;
    rootId: string | undefined;
    rootIds: readonly string[] | undefined;
  }): Promise<SQL[] | null> {
    const conditions: SQL[] = [];
    if (scope.fileRecordId) {
      conditions.push(sql`file_record_id = ${scope.fileRecordId}`);
    }
    if (scope.chunkType) {
      conditions.push(sql`chunk_type = ${scope.chunkType}`);
    }
    if (scope.rootId !== undefined) {
      conditions.push(
        inArray(
          fileChunks.fileRecordId,
          this.db
            .select({ id: fileRecords.id })
            .from(fileRecords)
            .where(eq(fileRecords.rootId, scope.rootId))
        )
      );
    }
    if (scope.rootIds !== undefined) {
      const rootScopeCondition = this.rootScopedFileIdCondition(scope.rootIds);
      if (rootScopeCondition === null) {
        return null;
      }
      conditions.push(rootScopeCondition);
    }
    if (scope.normalizedSnapshotId) {
      conditions.push(sql`EXISTS (
        SELECT 1
        FROM ${selectionSnapshotFiles}
        JOIN ${fileRecords} ON ${fileRecords.path} = ${selectionSnapshotFiles.filePath}
        WHERE ${selectionSnapshotFiles.snapshotId} = ${scope.normalizedSnapshotId}
          AND ${fileRecords.id} = ${fileChunks.fileRecordId}
      )`);
    }
    if (scope.normalizedFilePaths && scope.normalizedFilePaths.length > 0) {
      const rows = await this.db
        .select({ id: fileRecords.id })
        .from(fileRecords)
        .where(inArray(fileRecords.path, scope.normalizedFilePaths));
      const fileRecordIds = rows.map((row) => row.id).filter(Boolean);
      if (fileRecordIds.length === 0) {
        return null;
      }
      conditions.push(inArray(fileChunks.fileRecordId, fileRecordIds));
    }
    return conditions;
  }

  /**
   * Route a NARROWED similarity search (exact filtered scan vs ANN) from two
   * bounded selectivity counts. See `resolveFilteredVectorSearchRoute` in
   * `_shared.ts` for the decision rule and the measured recall collapse it fixes.
   */
  private async resolveNarrowedSearchRoute(
    embeddingSetId: string,
    scopeConditions: readonly SQL[]
  ): Promise<FilteredVectorSearchRoute> {
    const setCondition = sql`embedding_set_id = ${embeddingSetId}`;
    return await resolveFilteredVectorSearchRoute(
      (cap) => this.runBoundedCount([setCondition, ...scopeConditions], cap),
      (cap) => this.runBoundedCount([setCondition], cap)
    );
  }

  /**
   * Count matching rows, stopping the scan once `cap` rows are seen. Cheap
   * predicates only — the callers deliberately omit `vector_dims(embedding)`
   * (it would detoast every candidate's vector just to route the query).
   */
  private async runBoundedCount(conditions: readonly SQL[], cap: number): Promise<number> {
    const boundedCap = Math.max(1, Math.floor(cap));
    let where = sql`embedding IS NOT NULL`;
    for (const condition of conditions) {
      where = sql`${where} AND ${condition}`;
    }
    const result = await this.db.execute(
      sql`SELECT COUNT(*)::int AS c FROM (SELECT 1 FROM file_chunks WHERE ${where} LIMIT ${sql.raw(String(boundedCap))}) t`
    );
    const row = result.rows[0] as { c?: number | string } | undefined;
    return Number(row?.c ?? 0);
  }

  /**
   * Parity with the raw/Electron variants (BST-989 slice 2): both bodies are
   * the shared query functions, run through drizzle's $client — the real
   * underlying PGlite — so parameterized SQL and row handling are identical
   * across all three variants. NOTE: $client exists only on the handle
   * drizzle() constructs, NOT on a drizzle transaction handle — inside
   * db.transaction(...) these methods must not be called through the tx
   * (insertManyWithTx takes the caller's tx query explicitly for that case).
   */
  async findGrepCandidates(options: GrepCandidateOptions): Promise<GrepCandidate[]> {
    return runFindGrepCandidatesQuery(
      (sqlText, params) => this.db.$client.query(sqlText, params),
      options
    );
  }

  async insertManyWithTx(tx: FileChunkQueryTx, chunks: FileChunkInsert[]): Promise<FileChunk[]> {
    return runInsertManyWithTx(
      (sqlText, params) => tx.query(sqlText, params),
      chunks,
      (row) => this.fromRawRow(row as Record<string, unknown>)
    );
  }

  private fromRow(row: typeof fileChunks.$inferSelect): FileChunk {
    const chunk: FileChunk = {
      chunkIndex: row.chunkIndex,
      chunkSize: row.chunkSize ?? 0,
      chunkType: row.chunkType ?? 'text',
      content: row.content,
      contentHash: row.contentHash ?? '',
      createdAt: row.createdAt.toISOString(),
      fileRecordId: row.fileRecordId,
      id: row.id,
      tokenCount: row.tokenCount ?? 0,
      updatedAt: row.updatedAt.toISOString(),
    };

    if (row.startLine !== null) {
      chunk.startLine = row.startLine;
    }
    if (row.endLine !== null) {
      chunk.endLine = row.endLine;
    }
    if (row.startOffset !== null) {
      chunk.startOffset = row.startOffset;
    }
    if (row.endOffset !== null) {
      chunk.endOffset = row.endOffset;
    }
    if (row.embedding) {
      chunk.embedding = row.embedding;
    }
    if (row.embeddingSetId) {
      chunk.embeddingSetId = row.embeddingSetId;
    }
    if (row.embeddingUpdatedAt) {
      chunk.embeddingUpdatedAt = row.embeddingUpdatedAt.toISOString();
    }
    if (row.embeddingHash) {
      chunk.embeddingHash = row.embeddingHash;
    }

    return chunk;
  }

  private fromRawRow(row: Record<string, unknown>): FileChunk {
    const chunk: FileChunk = {
      chunkIndex: Number(row['chunk_index']),
      chunkSize: Number(row['chunk_size'] ?? 0),
      chunkType: (row['chunk_type'] as FileChunk['chunkType']) ?? 'text',
      content: String(row['content']),
      contentHash: row['content_hash'] ? String(row['content_hash']) : '',
      createdAt: String(row['created_at']),
      fileRecordId: String(row['file_record_id']),
      id: String(row['id']),
      tokenCount: Number(row['token_count'] ?? 0),
      updatedAt: String(row['updated_at']),
    };

    if (row['start_line'] !== null && row['start_line'] !== undefined) {
      chunk.startLine = Number(row['start_line']);
    }
    if (row['end_line'] !== null && row['end_line'] !== undefined) {
      chunk.endLine = Number(row['end_line']);
    }
    if (row['start_offset'] !== null && row['start_offset'] !== undefined) {
      chunk.startOffset = Number(row['start_offset']);
    }
    if (row['end_offset'] !== null && row['end_offset'] !== undefined) {
      chunk.endOffset = Number(row['end_offset']);
    }
    if (row['embedding']) {
      const embStr = String(row['embedding']);
      // Parse vector string format "[0.1,0.2,0.3]"
      const cleaned = embStr.replace(/[[\]()]/g, '');
      chunk.embedding = cleaned.split(',').map(Number);
    }
    const embeddingDimensions = resolveEmbeddingDimensions(
      chunk.embedding,
      row['embedding_dims'] as string | number | null | undefined
    );
    if (embeddingDimensions !== undefined) {
      chunk.embeddingDimensions = embeddingDimensions;
    }
    if (row['embedding_set_id']) {
      chunk.embeddingSetId = String(row['embedding_set_id']);
    }
    if (row['embedding_updated_at']) {
      chunk.embeddingUpdatedAt = String(row['embedding_updated_at']);
    }
    if (row['embedding_hash']) {
      chunk.embeddingHash = String(row['embedding_hash']);
    }

    return chunk;
  }
}
