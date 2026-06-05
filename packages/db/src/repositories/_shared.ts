/**
 * Shared utilities for database repositories
 */

import { MAX_EMBEDDING_DIMENSION } from '@brainstrike/types';

export { DEFAULT_EMBEDDING_DIMENSION, MAX_EMBEDDING_DIMENSION } from '@brainstrike/types';

export interface Queryable {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Maximum number of file path filters allowed inline for similarity search.
 * Larger selections should use a snapshot table to avoid huge IN clauses.
 */
export const MAX_INLINE_FILE_PATHS = 500;

/**
 * Maximum number of embedding dimension entries to cache.
 * Prevents unbounded memory growth in long-running processes.
 */
const MAX_CACHE_SIZE = 100;

/**
 * LRU cache for embedding dimensions with bounded size.
 * Uses Map's insertion order property for LRU eviction.
 */
class EmbeddingDimensionCache {
  private readonly cache = new Map<string, number>();
  private readonly maxSize: number;

  constructor(maxSize: number = MAX_CACHE_SIZE) {
    this.maxSize = maxSize;
  }

  get(key: string): number | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used) by re-inserting
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: number): void {
    // If key exists, delete it first to update insertion order
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// Process-local LRU cache with bounded size to prevent memory leaks.
const embeddingDimensionCache = new EmbeddingDimensionCache(MAX_CACHE_SIZE);

/**
 * Partition embedding set IDs into cached results and uncached IDs.
 */
function partitionCachedIds(ids: string[]): {
  cached: Map<string, number>;
  uncachedIds: string[];
} {
  const cached = new Map<string, number>();
  const uncachedIds: string[] = [];
  for (const id of ids) {
    const value = embeddingDimensionCache.get(id);
    if (typeof value === 'number') {
      cached.set(id, value);
    } else {
      uncachedIds.push(id);
    }
  }
  return { cached, uncachedIds };
}

/**
 * Parse and validate a raw dimension value from a database row.
 * Returns the validated dimension or throws on invalid/out-of-range values.
 */
function parseAndValidateRowDimension(rowId: string, dimensionsRaw: unknown): number {
  const dimensions = typeof dimensionsRaw === 'number' ? dimensionsRaw : Number(dimensionsRaw);
  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    throw new Error(
      `Embedding set ${rowId} is missing or has invalid dimensions (${dimensionsRaw}).`
    );
  }
  if (dimensions > MAX_EMBEDDING_DIMENSION) {
    throw new Error(
      `Embedding set ${rowId} defines ${dimensions} dimensions, exceeding the supported maximum (${MAX_EMBEDDING_DIMENSION}).`
    );
  }
  return dimensions;
}

/**
 * Fetch missing embedding set dimensions from the database, validate them,
 * populate the cache, and merge into the result map.
 */
async function fetchAndCacheMissingDimensions(
  db: Queryable,
  missingIds: string[],
  result: Map<string, number>
): Promise<void> {
  // ANY($1) is safe here: unique embedding set IDs are typically a small set
  // (most chunks in a batch share the same set), and insert batches are capped
  // at 250 rows, well within PG's parameter limits.
  const queryResult = await db.query<{ id: string; dimensions: number }>(
    'SELECT id, dimensions FROM embedding_sets WHERE id = ANY($1)',
    [missingIds]
  );

  for (const row of queryResult.rows) {
    const dimensions = parseAndValidateRowDimension(row.id, row.dimensions);
    embeddingDimensionCache.set(row.id, dimensions);
    result.set(row.id, dimensions);
  }

  for (const id of missingIds) {
    if (!result.has(id)) {
      throw new Error(`Embedding set ${id} is missing or has invalid dimensions.`);
    }
  }
}

export async function resolveEmbeddingSetDimensions(
  db: Queryable,
  embeddingSetIds: string[]
): Promise<Map<string, number>> {
  const uniqueIds = [...new Set(embeddingSetIds)];
  const { cached: result, uncachedIds } = partitionCachedIds(uniqueIds);

  if (uncachedIds.length > 0) {
    await fetchAndCacheMissingDimensions(db, uncachedIds, result);
  }

  return result;
}

function ensureArrayInput(embedding: number[]): void {
  if (!Array.isArray(embedding)) {
    throw new Error(
      `Invalid embedding: expected number array, received ${typeof embedding} instead.`
    );
  }
}

function ensureNumericValues(embedding: number[]): void {
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new Error('Embeddings must contain only finite numeric values.');
    }
  }
}

function assertEmbeddingDimensionBounds(dimension: number): void {
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error(`Embedding dimension ${dimension} is invalid. Expected a positive integer.`);
  }
  if (dimension > MAX_EMBEDDING_DIMENSION) {
    throw new Error(
      `Embedding dimension ${dimension} exceeds pgvector's supported maximum of ${MAX_EMBEDDING_DIMENSION}.`
    );
  }
}

function assertTargetDimensionBounds(dimension: number): void {
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new Error(
      `Invalid target embedding dimension (${dimension}). Expected a positive integer.`
    );
  }
  if (dimension > MAX_EMBEDDING_DIMENSION) {
    throw new Error(
      `Invalid target embedding dimension (${dimension}). Maximum supported is ${MAX_EMBEDDING_DIMENSION}.`
    );
  }
}

import { createLogger } from '@brainstrike/utils';

const logger = createLogger('DbRepositoriesShared');

/**
 * Parse embeddings from various formats (TEXT/pgvector/JSON)
 * Handles multiple input formats:
 * - JSON array string: "[0.1, 0.2, 0.3]"
 * - pgvector text format: "[0.1,0.2,0.3]" (no spaces)
 * - pgvector parentheses format: "(0.1,0.2,0.3)"
 * - Comma-separated string: "0.1,0.2,0.3"
 * - Native array: [0.1, 0.2, 0.3]
 *
 * @param embedding - The embedding data in various formats
 * @returns Parsed number array or undefined if parsing fails
 */
// Helper to validate array of numbers
function validateNumberArray(arr: unknown[]): arr is number[] {
  return arr.every((item) => typeof item === 'number');
}

// Helper to parse string to number array
function parseStringToNumbers(str: string): number[] {
  const parts = str.split(',').map((part) => part.trim());
  return parts.map((part) => {
    const num = Number.parseFloat(part);
    if (Number.isNaN(num)) {
      throw new Error(`Invalid number: ${part}`);
    }
    return num;
  });
}

// Helper to handle array inputs
function handleArrayInput(arr: unknown[]): number[] | undefined {
  if (validateNumberArray(arr)) {
    return arr;
  }
  logger.warn('parseEmbeddingLoose: Array contains non-numeric values');
  return;
}

// Helper to handle string inputs
function handleStringInput(str: string): number[] | undefined {
  let cleanedString = str.trim();

  // Remove outer brackets or parentheses
  if (cleanedString.startsWith('(') && cleanedString.endsWith(')')) {
    cleanedString = cleanedString.slice(1, -1);
    return parseStringToNumbers(cleanedString);
  }

  if (cleanedString.startsWith('[') && cleanedString.endsWith(']')) {
    // Try JSON.parse for proper JSON arrays
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed) && validateNumberArray(parsed)) {
        return parsed;
      }
    } catch {
      // Not valid JSON, remove brackets and continue
    }
    cleanedString = cleanedString.slice(1, -1);
  }

  return parseStringToNumbers(cleanedString);
}

export function parseEmbeddingLoose(embedding: unknown): number[] | undefined {
  if (!embedding) {
    return;
  }

  try {
    if (Array.isArray(embedding)) {
      return handleArrayInput(embedding);
    }

    if (typeof embedding === 'string') {
      return handleStringInput(embedding);
    }

    logger.warn('parseEmbeddingLoose: Unsupported embedding type', { type: typeof embedding });
    return;
  } catch (error) {
    logger.warn('parseEmbeddingLoose: Failed to parse embedding', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return;
  }
}

// Shared file_chunks column projections for read queries. Single source of truth
// so a schema change can't desync one platform — these go through sql.raw /
// string interpolation, so a stale per-repo copy would fail only at query time
// on that one platform, not at type-check.
const FILE_CHUNK_COLUMNS_BEFORE_EMBEDDING =
  'id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, start_line, end_line, start_offset, end_offset';
const FILE_CHUNK_COLUMNS_AFTER_EMBEDDING =
  'embedding_set_id, embedding_updated_at, embedding_hash, created_at, updated_at';

/** Full file_chunks column list, serializing the embedding vector to text. */
export const FILE_CHUNK_SELECT_COLUMNS = `${FILE_CHUNK_COLUMNS_BEFORE_EMBEDDING}, embedding::text AS embedding, ${FILE_CHUNK_COLUMNS_AFTER_EMBEDDING}`;

/**
 * Same columns, but projecting only the cheap dimension count
 * (`vector_dims(embedding)`) instead of the heavy embedding vector — for large
 * fan-out search reads (e.g. hybrid RRF source pools) that never use the vector
 * values, only ids, scores, and the dimension count.
 */
export const FILE_CHUNK_SELECT_COLUMNS_DIMS_ONLY = `${FILE_CHUNK_COLUMNS_BEFORE_EMBEDDING}, vector_dims(embedding) AS embedding_dims, ${FILE_CHUNK_COLUMNS_AFTER_EMBEDDING}`;

/**
 * Maximum number of candidate rows a similarity search may overfetch before
 * ranking + cutting to the requested limit. Bounds worst-case materialization
 * so a large user limit (up to the 2,000 product ceiling) can't pull tens of
 * thousands of rows into the renderer.
 */
export const MAX_OVERFETCH_LIMIT = 10_000;

/**
 * Compute the overfetch row count for a similarity search: 10× the requested
 * limit (better rank quality), floored at 100 and capped at
 * {@link MAX_OVERFETCH_LIMIT}. Shared by all repositories so the bound is
 * symmetric across the Drizzle/PGlite/Electron platforms.
 *
 * INTENTIONAL BOUND, NOT A SILENT FALLBACK: because the candidate pool is capped
 * here and `searchSimilar` finishes with `slice(0, limit)`, a `limit` ABOVE
 * {@link MAX_OVERFETCH_LIMIT} (10k) receives at most that many rows. The UI
 * search path is clamped to the 2,000 product ceiling (`RESULT_LIMIT_MAX` in
 * `@brainstrike/ui`), far under the cap, so this only affects a non-UI caller
 * deliberately requesting >10k results (e.g. an oversized RAG topK) — and 10k
 * local candidates is already an extreme fan-out. For `limit <= 10k` the
 * returned count is unaffected; `1k < limit <= 10k` only trades some
 * oversampling headroom.
 */
export function computeOverfetchLimit(limit: number): number {
  return Math.min(Math.max(limit * 10, 100), MAX_OVERFETCH_LIMIT);
}

/**
 * Resolve a chunk's embedding dimension count from whichever the row carried.
 *
 * Prefers the loaded vector's length; falls back to the projected
 * `vector_dims(embedding)` value used when a search omits the heavy vector
 * payload. Returns `undefined` when neither is present (chunk has no embedding).
 */
export function resolveEmbeddingDimensions(
  embedding: number[] | undefined,
  projectedDims: string | number | null | undefined
): number | undefined {
  if (embedding) {
    return embedding.length;
  }
  if (projectedDims === null || projectedDims === undefined) {
    return;
  }
  const dims = typeof projectedDims === 'number' ? projectedDims : Number(projectedDims);
  return Number.isFinite(dims) && dims > 0 ? dims : undefined;
}

/**
 * Batch an array into chunks of specified size
 * @param items - Array to batch
 * @param batchSize - Size of each batch
 * @returns Array of batches
 */
export function batchArray<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * Compute cosine similarity between two vectors
 * @param a - First vector
 * @param b - Second vector
 * @returns Cosine similarity between -1 and 1, or NaN if computation fails
 */
export function computeCosineSimilarity(a: number[], b: number[]): number {
  if (!(a && b) || a.length !== b.length || a.length === 0) {
    return Number.NaN;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const aVal = a[i];
    const bVal = b[i];
    if (
      aVal === undefined ||
      bVal === undefined ||
      !Number.isFinite(aVal) ||
      !Number.isFinite(bVal)
    ) {
      return Number.NaN;
    }
    dotProduct += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  if (normA === 0 || normB === 0) {
    return Number.NaN;
  }

  const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));

  // Clamp to [-1, 1] range to handle floating-point precision issues
  return Math.max(-1, Math.min(1, similarity));
}

/**
 * Convert cosine similarity to a search-friendly similarity score in [0, 1] range
 * @param cosineSimilarity - Raw cosine similarity value [-1, 1]
 * @returns Similarity score in [0, 1] range, where 1 is most similar
 */
export function cosineToSearchSimilarity(cosineSimilarity: number): number {
  if (!Number.isFinite(cosineSimilarity)) {
    return 0;
  }
  // Convert [-1, 1] to [0, 1] where 1 means identical and 0 means opposite
  return (cosineSimilarity + 1) / 2;
}

export interface UpdateBuilder {
  index: number;
  setParts: string[];
  values: unknown[];
}

export function createUpdateBuilder(startIndex = 1): UpdateBuilder {
  return { setParts: [], values: [], index: startIndex };
}

export function appendColumn(builder: UpdateBuilder, column: string, value: unknown): void {
  builder.setParts.push(`${column} = $${builder.index}`);
  builder.values.push(value);
  builder.index += 1;
}

export function appendColumnIfDefined<T>(
  builder: UpdateBuilder,
  column: string,
  value: T | undefined
): void {
  if (value !== undefined) {
    appendColumn(builder, column, value);
  }
}

export function appendRawClause(builder: UpdateBuilder, clause: string, value: unknown): void {
  builder.setParts.push(`${clause} = $${builder.index}`);
  builder.values.push(value);
  builder.index += 1;
}

export async function validateEmbeddingDimensions(
  db: Queryable,
  embeddingsData: {
    embedding?: number[] | undefined;
    embeddingSetId?: string | null;
    expectedDimension?: number;
  }[]
): Promise<void> {
  // Extract all unique embeddingSetIds to pre-fetch them in one batch
  const uniqueEmbeddingSetIds = new Set<string>();
  for (const data of embeddingsData) {
    if (data.embedding && data.embeddingSetId) {
      uniqueEmbeddingSetIds.add(data.embeddingSetId);
    }
  }

  // Pre-warm the cache with a single batch query and keep the result map
  // so we can look up dimensions synchronously in the loop below.
  const dimensionMap =
    uniqueEmbeddingSetIds.size > 0
      ? await resolveEmbeddingSetDimensions(db, Array.from(uniqueEmbeddingSetIds))
      : new Map<string, number>();

  // Validate each embedding synchronously using the pre-fetched dimension map
  for (const data of embeddingsData) {
    if (!data.embedding) {
      continue;
    }

    ensureArrayInput(data.embedding);
    ensureNumericValues(data.embedding);
    const embeddingDimension = data.embedding.length;
    assertEmbeddingDimensionBounds(embeddingDimension);

    // Resolve the target dimension from the pre-fetched map or from
    // the explicit expectedDimension option — no async call needed.
    let targetDimension: number | undefined;
    if (data.embeddingSetId) {
      targetDimension = dimensionMap.get(data.embeddingSetId);
    } else if (typeof data.expectedDimension === 'number') {
      targetDimension = data.expectedDimension;
    }

    // Payloads without an embeddingSetId (and no explicit expectedDimension)
    // skip the dimension check — they represent embeddings not yet bound to a
    // specific set, so there is no target dimension to validate against.
    if (targetDimension === undefined) {
      continue;
    }

    assertTargetDimensionBounds(targetDimension);
    if (embeddingDimension !== targetDimension) {
      throw new Error(
        `Embedding dimension mismatch: received ${embeddingDimension}, expected ${targetDimension}.`
      );
    }
  }
}
