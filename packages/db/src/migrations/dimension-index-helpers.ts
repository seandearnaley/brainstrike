/**
 * Helper functions for creating and managing dimension-based HNSW indexes.
 * These indexes use partial indexes with expression casting to support
 * multiple embedding dimensions in a single dimensionless VECTOR column.
 *
 * SECURITY NOTE: All functions that interpolate values into SQL must validate
 * those values first to prevent SQL injection. Dimension and HNSW parameters
 * are validated before being used in SQL strings.
 */

import { createLogger } from '@brainstrike/utils';

const logger = createLogger('DimensionIndexHelpers');

interface HnswParams {
  ef: number;
  m: number;
}

/**
 * Maximum dimension for validation (theoretical limit for vector storage).
 */
const MAX_DIMENSION = 65_535;

/**
 * Maximum dimension supported by pgvector's HNSW index.
 * Vectors with more dimensions can still be stored and queried,
 * but without HNSW index acceleration (falls back to sequential scan).
 * @see https://github.com/pgvector/pgvector#hnsw
 */
// halfvec HNSW indexes support up to 4000 dimensions (vs 2000 for full-precision
// vector). The dimension index helpers build halfvec indexes, so the ceiling is 4000.
export const MAX_HNSW_DIMENSION = 4000;

/**
 * Maximum allowed value for HNSW M parameter.
 * Higher values use more memory but may improve recall.
 */
const MAX_HNSW_M = 1000;

/**
 * Maximum allowed value for HNSW ef_construction parameter.
 * Higher values build better indexes but take longer.
 */
const MAX_HNSW_EF = 10_000;

/**
 * Validates a dimension value for safe use in SQL interpolation.
 * @throws Error if dimension is not a safe positive integer within bounds
 */
function validateDimensionForSql(dimension: number, context: string): void {
  if (
    typeof dimension !== 'number' ||
    !Number.isInteger(dimension) ||
    dimension <= 0 ||
    dimension > MAX_DIMENSION
  ) {
    throw new Error(
      `${context}: Invalid dimension ${dimension}. Must be integer between 1 and ${MAX_DIMENSION}.`
    );
  }
}

/**
 * Validates HNSW parameters for safe use in SQL interpolation.
 * @throws Error if parameters are not safe positive integers within bounds
 */
function validateHnswParamsForSql(params: HnswParams, context: string): void {
  if (
    typeof params.m !== 'number' ||
    !Number.isInteger(params.m) ||
    params.m <= 0 ||
    params.m > MAX_HNSW_M
  ) {
    throw new Error(
      `${context}: Invalid HNSW m parameter ${params.m}. Must be integer between 1 and ${MAX_HNSW_M}.`
    );
  }

  if (
    typeof params.ef !== 'number' ||
    !Number.isInteger(params.ef) ||
    params.ef <= 0 ||
    params.ef > MAX_HNSW_EF
  ) {
    throw new Error(
      `${context}: Invalid HNSW ef_construction parameter ${params.ef}. Must be integer between 1 and ${MAX_HNSW_EF}.`
    );
  }
}

interface DimensionIndexDb {
  exec(sql: string, params?: unknown): Promise<unknown>;
  query<T = unknown>(sql: string, params?: unknown): Promise<{ rows: T[] }>;
}

/**
 * Read HNSW tuning parameters from environment variables.
 * @returns HNSW index configuration parameters
 */
export function hnswParams(): HnswParams {
  const envObj = (
    globalThis as unknown as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;

  const m = Number(envObj?.['HNSW_M'] ?? '16');
  const ef = Number(envObj?.['HNSW_EF_CONSTRUCTION'] ?? '64');

  return {
    m: Number.isFinite(m) && m > 0 ? Math.floor(m) : 16,
    ef: Number.isFinite(ef) && ef > 0 ? Math.floor(ef) : 64,
  };
}

/**
 * Generate consistent index name for a dimension.
 * @param dimension - The embedding dimension
 * @returns Index name string
 */
function indexName(dimension: number): string {
  return `idx_file_chunks_emb_hnsw_${dimension}`;
}

/**
 * Create an HNSW index for a specific embedding dimension.
 * Uses partial indexing with expression casting to support dimensionless VECTOR column.
 *
 * SECURITY: All parameters are validated before SQL interpolation to prevent injection.
 *
 * @param db - PGlite database instance
 * @param dimension - The embedding dimension to index (must be positive integer <= 65535)
 * @param params - HNSW tuning parameters (m, ef_construction) - must be positive integers
 */
export async function createDimensionIndex(
  db: DimensionIndexDb,
  dimension: number,
  params: HnswParams
): Promise<void> {
  // CRITICAL: Validate all interpolated values before SQL construction
  // This prevents SQL injection even if callers pass malicious input
  validateDimensionForSql(dimension, 'createDimensionIndex');
  validateHnswParamsForSql(params, 'createDimensionIndex');

  // pgvector's halfvec HNSW index supports up to 4000 dimensions (MAX_HNSW_DIMENSION).
  // Vectors with more dimensions can still be stored and queried via sequential scan.
  if (dimension > MAX_HNSW_DIMENSION) {
    logger.warn(
      `Skipping HNSW index creation for ${dimension}D vectors: ` +
        `pgvector HNSW limit is ${MAX_HNSW_DIMENSION}. ` +
        'Queries will use sequential scan (slower for large datasets).'
    );
    return;
  }

  const name = indexName(dimension);

  // Validate index name format as additional defense-in-depth
  // This ensures the name matches expected format: idx_file_chunks_emb_hnsw_<digits>
  if (!/^idx_file_chunks_emb_hnsw_\d+$/.test(name)) {
    throw new Error(`createDimensionIndex: Invalid index name format: ${name}`);
  }

  // Use a half-precision (halfvec) expression cast + partial index on vector_dims().
  // halfvec halves the on-disk HNSW index and speeds builds/search for a tiny
  // recall cost; it also raises pgvector's HNSW dimension ceiling from 2000 to
  // 4000, so large models (e.g. 3072-dim) get an ANN index instead of a seq scan.
  // The full-precision vector stays in the column; only the index/ranking is fp16.
  // The query planner uses this index when the ORDER BY casts to halfvec(N) too.
  // SECURITY: dimension and params are validated integers above, safe for SQL interpolation
  const sqlStatement = `
    CREATE INDEX IF NOT EXISTS ${name} ON file_chunks
    USING hnsw ((embedding::halfvec(${dimension})) halfvec_cosine_ops)
    WITH (m=${params.m}, ef_construction=${params.ef})
    WHERE vector_dims(embedding) = ${dimension}
  `;

  try {
    await db.exec(sqlStatement);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Ignore "already exists" errors for idempotency
    if (!msg.includes('already exists')) {
      throw new Error(`Failed to create HNSW index for ${dimension}D: ${msg}`);
    }
  }
}

/**
 * Drop an HNSW index for a specific dimension.
 *
 * SECURITY: Dimension is validated before SQL interpolation to prevent injection.
 *
 * @param db - PGlite database instance
 * @param dimension - The embedding dimension whose index to drop (must be positive integer <= 65535)
 */
export async function dropDimensionIndex(
  db: Pick<DimensionIndexDb, 'exec'>,
  dimension: number
): Promise<void> {
  // Validate dimension to prevent SQL injection via index name
  validateDimensionForSql(dimension, 'dropDimensionIndex');

  const name = indexName(dimension);

  // Validate index name format as additional defense-in-depth
  if (!/^idx_file_chunks_emb_hnsw_\d+$/.test(name)) {
    throw new Error(`dropDimensionIndex: Invalid index name format: ${name}`);
  }

  try {
    await db.exec(`DROP INDEX IF EXISTS ${name}`);
  } catch {
    // Ignore errors on drop - best effort cleanup
  }
}

/**
 * Get all distinct dimensions currently in use by embedding sets.
 *
 * @param db - PGlite database instance
 * @returns Array of distinct dimension values
 */
export async function getDistinctDimensions(
  db: Pick<DimensionIndexDb, 'query'>
): Promise<number[]> {
  const result = await db.query<{ dimensions: number }>(
    'SELECT DISTINCT dimensions FROM embedding_sets WHERE dimensions IS NOT NULL ORDER BY dimensions'
  );
  return result.rows.map((row) => row.dimensions);
}

/**
 * Ensure an HNSW index exists for a given dimension.
 * This is idempotent - safe to call multiple times.
 *
 * @param db - PGlite database instance
 * @param dimension - The embedding dimension to ensure index for
 */
export async function ensureDimensionIndexExists(
  db: DimensionIndexDb,
  dimension: number
): Promise<void> {
  const params = hnswParams();
  await createDimensionIndex(db, dimension, params);
}

/**
 * Check if an HNSW index exists for a given dimension.
 *
 * @param db - PGlite database instance
 * @param dimension - The embedding dimension to check
 * @returns true if index exists
 */
export async function dimensionIndexExists(
  db: Pick<DimensionIndexDb, 'query'>,
  dimension: number
): Promise<boolean> {
  const name = indexName(dimension);
  const result = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text as count FROM pg_indexes WHERE indexname = $1',
    [name]
  );
  return Number(result.rows[0]?.count ?? 0) > 0;
}

/**
 * Drop all dimension-based HNSW indexes.
 * Useful for cleanup during migration rollback.
 *
 * @param db - PGlite database instance
 * @param dimensions - Array of dimensions whose indexes to drop
 */
export async function dropAllDimensionIndexes(
  db: Pick<DimensionIndexDb, 'exec'>,
  dimensions: number[]
): Promise<void> {
  for (const dim of dimensions) {
    await dropDimensionIndex(db, dim);
  }
}
