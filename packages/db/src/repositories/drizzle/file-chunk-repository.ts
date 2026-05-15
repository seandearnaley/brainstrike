/**
 * Drizzle-based FileChunk Repository
 *
 * This is the Drizzle ORM version of the FileChunkRepository.
 * Provides type-safe database operations for file chunks and embeddings.
 *
 * Note: Some advanced vector operations use raw SQL via Drizzle's execute()
 * since pgvector operators aren't natively supported by the query builder.
 */

import { count, eq, inArray, sql } from 'drizzle-orm';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type {
  ChunkSearchOptions,
  ChunkSearchResult,
  FileChunk,
  FileChunkInsert,
  FileChunkUpdate,
} from '../../models/file-chunk.js';
import {
  embeddingSets,
  fileChunks,
  fileRecords,
  selectionSnapshotFiles,
} from '../../schema/index.js';
import { MAX_INLINE_FILE_PATHS } from '../_shared.js';

type DrizzleDb = PgliteDatabase;

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
 * Validates that a dimension value is a safe positive integer within pgvector limits.
 * @throws Error if dimension is not a safe positive integer
 */
function validateDimension(dimension: number, context: string): void {
  if (
    typeof dimension !== 'number' ||
    !Number.isInteger(dimension) ||
    dimension <= 0 ||
    dimension > MAX_EMBEDDING_DIMENSION
  ) {
    throw new Error(
      `${context}: Invalid dimension value: ${dimension} (must be 1-${MAX_EMBEDDING_DIMENSION})`
    );
  }
}

/**
 * Maximum number of rows to overfetch when searching for similar embeddings.
 * This prevents memory exhaustion when limit is very large.
 */
const MAX_OVERFETCH_LIMIT = 10_000;

/**
 * Maximum user-specified limit for similarity search results.
 * Prevents excessive memory usage from user requests.
 */
const MAX_USER_LIMIT = 1000;

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

export class DrizzleFileChunkRepository {
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
    const [row] = await this.db
      .insert(fileChunks)
      .values({
        id: chunk.id,
        fileRecordId: chunk.fileRecordId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        contentHash: chunk.contentHash ?? null,
        tokenCount: chunk.tokenCount ?? null,
        chunkType: chunk.chunkType ?? null,
        chunkSize: chunk.chunkSize ?? null,
        startLine: chunk.startLine ?? null,
        endLine: chunk.endLine ?? null,
        startOffset: chunk.startOffset ?? null,
        endOffset: chunk.endOffset ?? null,
        embedding: chunk.embedding ?? null,
        embeddingSetId: chunk.embeddingSetId ?? null,
        embeddingUpdatedAt: chunk.embeddingUpdatedAt ? new Date(chunk.embeddingUpdatedAt) : null,
        embeddingHash: chunk.embeddingHash ?? null,
        contentTsvector: sql`to_tsvector('english', ${chunk.content})`,
        createdAt: new Date(chunk.createdAt),
        updatedAt: new Date(chunk.updatedAt),
      })
      .onConflictDoUpdate({
        target: fileChunks.id,
        set: {
          content: sql`excluded.content`,
          contentHash: sql`excluded.content_hash`,
          tokenCount: sql`excluded.token_count`,
          chunkType: sql`excluded.chunk_type`,
          chunkSize: sql`excluded.chunk_size`,
          startLine: sql`excluded.start_line`,
          endLine: sql`excluded.end_line`,
          startOffset: sql`excluded.start_offset`,
          endOffset: sql`excluded.end_offset`,
          contentTsvector: sql`to_tsvector('english', excluded.content)`,
          embedding: sql`excluded.embedding`,
          embeddingSetId: sql`excluded.embedding_set_id`,
          embeddingUpdatedAt: sql`excluded.embedding_updated_at`,
          embeddingHash: sql`excluded.embedding_hash`,
          updatedAt: sql`excluded.updated_at`,
        },
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

    const values = chunks.map((chunk) => ({
      id: chunk.id,
      fileRecordId: chunk.fileRecordId,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      contentHash: chunk.contentHash ?? null,
      tokenCount: chunk.tokenCount ?? null,
      chunkType: chunk.chunkType ?? null,
      chunkSize: chunk.chunkSize ?? null,
      startLine: chunk.startLine ?? null,
      endLine: chunk.endLine ?? null,
      startOffset: chunk.startOffset ?? null,
      endOffset: chunk.endOffset ?? null,
      embedding: chunk.embedding ?? null,
      embeddingSetId: chunk.embeddingSetId ?? null,
      embeddingUpdatedAt: chunk.embeddingUpdatedAt ? new Date(chunk.embeddingUpdatedAt) : null,
      embeddingHash: chunk.embeddingHash ?? null,
      contentTsvector: sql`to_tsvector('english', ${chunk.content})`,
      createdAt: new Date(chunk.createdAt),
      updatedAt: new Date(chunk.updatedAt),
    }));

    const rows = await this.db
      .insert(fileChunks)
      .values(values)
      .onConflictDoUpdate({
        target: fileChunks.id,
        set: {
          content: sql`excluded.content`,
          contentHash: sql`excluded.content_hash`,
          tokenCount: sql`excluded.token_count`,
          chunkType: sql`excluded.chunk_type`,
          chunkSize: sql`excluded.chunk_size`,
          startLine: sql`excluded.start_line`,
          endLine: sql`excluded.end_line`,
          startOffset: sql`excluded.start_offset`,
          endOffset: sql`excluded.end_offset`,
          contentTsvector: sql`to_tsvector('english', excluded.content)`,
          embedding: sql`excluded.embedding`,
          embeddingSetId: sql`excluded.embedding_set_id`,
          embeddingUpdatedAt: sql`excluded.embedding_updated_at`,
          embeddingHash: sql`excluded.embedding_hash`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning();

    return rows.map((row) => this.fromRow(row));
  }

  async update(chunk: FileChunkUpdate): Promise<FileChunk | null> {
    const updateData: Partial<typeof fileChunks.$inferInsert> = {
      updatedAt: new Date(chunk.updatedAt),
    };

    if (chunk.content !== undefined) {
      updateData.content = chunk.content;
      updateData.contentTsvector =
        sql`to_tsvector('english', ${chunk.content})` as unknown as string;
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
      filePaths,
      selectionSnapshotId,
    } = options;

    // Validate limit to prevent memory exhaustion from excessive requests
    if (limit > MAX_USER_LIMIT) {
      throw new Error(
        `searchSimilar limit ${limit} exceeds maximum allowed (${MAX_USER_LIMIT}). ` +
          'Use pagination for larger result sets.'
      );
    }

    if (!embeddingSetId) {
      throw new Error('searchSimilar requires embeddingSetId to avoid dimension mismatches');
    }

    const normalizedFilePaths = this.normalizeFilePaths(filePaths);
    if (normalizedFilePaths && normalizedFilePaths.length > MAX_INLINE_FILE_PATHS) {
      throw new Error(
        `searchSimilar filePaths limit exceeded (${normalizedFilePaths.length} > ${MAX_INLINE_FILE_PATHS}). ` +
          'Use selectionSnapshotId for large selections.'
      );
    }
    const normalizedSnapshotId = selectionSnapshotId?.trim() || undefined;

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
    const { similarityExpr, orderExpr } = this.buildDistanceExpressions(
      distance as 'cosine' | 'l2' | 'ip',
      dimension
    );

    // Convert validated embedding to pgvector literal format
    // Safe because validateEmbeddingVector guarantees all values are finite numbers
    const vectorLiteral = toPgvectorLiteral(queryEmbedding);

    // Overfetch to improve result quality, but cap at MAX_OVERFETCH_LIMIT
    // to prevent memory exhaustion with very large limit values
    const overfetchLimit = Math.min(Math.max(limit * 10, 100), MAX_OVERFETCH_LIMIT);

    // Build dynamic query with proper parameterization
    // Note: We use sql template tag for parameters, but still need raw for pgvector operators
    // The embeddingSetId, fileRecordId, and chunkType are parameterized via sql template
    // The vectorLiteral is safe because it was validated via validateEmbeddingVector()
    let baseQuery = sql`
      SELECT *,
        ${sql.raw(similarityExpr.replace(/\$1/g, `'${vectorLiteral}'`))} as similarity,
        ROW_NUMBER() OVER (ORDER BY ${sql.raw(orderExpr.replace(/\$1/g, `'${vectorLiteral}'`))}) as rank
      FROM file_chunks
      WHERE embedding IS NOT NULL
        AND vector_dims(embedding) = ${dimension}
        AND embedding_set_id = ${embeddingSetId}
    `;

    if (fileRecordId) {
      baseQuery = sql`${baseQuery} AND file_record_id = ${fileRecordId}`;
    }
    if (chunkType) {
      baseQuery = sql`${baseQuery} AND chunk_type = ${chunkType}`;
    }
    if (normalizedSnapshotId) {
      baseQuery = sql`${baseQuery} AND EXISTS (
        SELECT 1
        FROM ${selectionSnapshotFiles}
        JOIN ${fileRecords} ON ${fileRecords.path} = ${selectionSnapshotFiles.filePath}
        WHERE ${selectionSnapshotFiles.snapshotId} = ${normalizedSnapshotId}
          AND ${fileRecords.id} = ${fileChunks.fileRecordId}
      )`;
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
      baseQuery = sql`${baseQuery} AND ${inArray(fileChunks.fileRecordId, fileRecordIds)}`;
    }

    baseQuery = sql`${baseQuery}
      ORDER BY ${sql.raw(orderExpr.replace(/\$1/g, `'${vectorLiteral}'`))}
      LIMIT ${overfetchLimit}
    `;

    const result = await this.db.execute(baseQuery);

    const mapped = (result.rows as Record<string, unknown>[]).map((row) => ({
      chunk: this.fromRawRow(row),
      similarity: Number(row['similarity']),
      rank: Number(row['rank']),
    }));

    // Apply threshold and limit
    return mapped
      .filter((r) => Number.isFinite(r.similarity) && r.similarity >= threshold)
      .slice(0, limit);
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

    // Build WHERE clause dynamically
    let baseQuery = sql`
      SELECT
        id, file_record_id, chunk_index, content, content_hash,
        token_count, chunk_type, chunk_size, start_line, end_line, start_offset, end_offset, embedding::text AS embedding,
        embedding_set_id, embedding_updated_at, embedding_hash, created_at, updated_at,
        ts_rank(content_tsvector, ${sql.raw(tsqueryFunc)}(${language}::regconfig, ${trimmedQuery}), ${rankNormalization}) as fts_rank,
        ts_headline(${language}::regconfig, content, ${sql.raw(tsqueryFunc)}(${language}::regconfig, ${trimmedQuery}),
          'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15') as headline,
        ROW_NUMBER() OVER (ORDER BY ts_rank(content_tsvector, ${sql.raw(tsqueryFunc)}(${language}::regconfig, ${trimmedQuery}), ${rankNormalization}) DESC) as position
      FROM file_chunks
      WHERE content_tsvector IS NOT NULL
        AND content_tsvector @@ ${sql.raw(tsqueryFunc)}(${language}::regconfig, ${trimmedQuery})
    `;

    if (fileRecordId) {
      baseQuery = sql`${baseQuery} AND file_record_id = ${fileRecordId}`;
    }
    if (chunkType) {
      baseQuery = sql`${baseQuery} AND chunk_type = ${chunkType}`;
    }
    if (normalizedSnapshotId) {
      baseQuery = sql`${baseQuery} AND EXISTS (
        SELECT 1
        FROM ${selectionSnapshotFiles}
        JOIN ${fileRecords} ON ${fileRecords.path} = ${selectionSnapshotFiles.filePath}
        WHERE ${selectionSnapshotFiles.snapshotId} = ${normalizedSnapshotId}
          AND ${fileRecords.id} = ${fileChunks.fileRecordId}
      )`;
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
      baseQuery = sql`${baseQuery} AND ${inArray(fileChunks.fileRecordId, fileRecordIds)}`;
    }

    baseQuery = sql`${baseQuery}
      ORDER BY fts_rank DESC
      LIMIT ${limit}
    `;

    const result = await this.db.execute(baseQuery);
    return this.mapFTSResults(result.rows as Record<string, unknown>[], threshold);
  }

  /**
   * Map raw FTS query results to FTSSearchResult objects
   */
  private mapFTSResults(
    rows: Record<string, unknown>[],
    threshold: number
  ): import('../../models/file-chunk.js').FTSSearchResult[] {
    const results: import('../../models/file-chunk.js').FTSSearchResult[] = [];
    for (const row of rows) {
      const rank = Number(row['fts_rank']);
      // Apply threshold filter
      if (threshold > 0 && rank < threshold) {
        continue;
      }
      const ftsResult: import('../../models/file-chunk.js').FTSSearchResult = {
        chunk: this.fromRawRow(row),
        rank,
        position: Number(row['position']),
      };
      if (row['headline']) {
        ftsResult.headline = String(row['headline']);
      }
      results.push(ftsResult);
    }
    return results;
  }

  /**
   * Get the PostgreSQL tsquery function for the given query mode
   */
  private getTsqueryFunction(mode: import('../../models/file-chunk.js').FTSQueryMode): string {
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
      totalChunks,
      chunksWithEmbeddings: 0,
      averageTokenCount: 0,
      chunkTypeDistribution: {} as Record<string, number>,
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
      totalChunks: totalResult?.count ?? 0,
      chunksWithEmbeddingsForSet: Number(countRow?.['count'] ?? 0),
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

  private buildDistanceExpressions(
    distance: 'cosine' | 'l2' | 'ip',
    dimension: number
  ): { similarityExpr: string; orderExpr: string } {
    // Validate dimension is a safe integer (defense-in-depth)
    validateDimension(dimension, 'buildDistanceExpressions');

    const embeddingCast = `(embedding::vector(${dimension}))`;
    const paramCast = `$1::vector(${dimension})`;

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

  private fromRow(row: typeof fileChunks.$inferSelect): FileChunk {
    const chunk: FileChunk = {
      id: row.id,
      fileRecordId: row.fileRecordId,
      chunkIndex: row.chunkIndex,
      content: row.content,
      contentHash: row.contentHash ?? '',
      tokenCount: row.tokenCount ?? 0,
      chunkType: row.chunkType ?? 'text',
      chunkSize: row.chunkSize ?? 0,
      createdAt: row.createdAt.toISOString(),
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
      id: String(row['id']),
      fileRecordId: String(row['file_record_id']),
      chunkIndex: Number(row['chunk_index']),
      content: String(row['content']),
      contentHash: row['content_hash'] ? String(row['content_hash']) : '',
      tokenCount: Number(row['token_count'] ?? 0),
      chunkType: (row['chunk_type'] as FileChunk['chunkType']) ?? 'text',
      chunkSize: Number(row['chunk_size'] ?? 0),
      createdAt: String(row['created_at']),
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
