import type { PGlite } from '@electric-sql/pglite';

/**
 * Helper functions for creating and managing dimension-based HNSW indexes.
 * These indexes use partial indexes with expression casting to support
 * multiple embedding dimensions in a single dimensionless VECTOR column.
 */

type HnswParams = {
  m: number;
  ef: number;
};

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
 * @param db - PGlite database instance
 * @param dimension - The embedding dimension to index
 * @param params - HNSW tuning parameters (m, ef_construction)
 */
export async function createDimensionIndex(
  db: Pick<PGlite, 'exec' | 'query'>,
  dimension: number,
  params: HnswParams
): Promise<void> {
  const name = indexName(dimension);

  // Use expression cast + partial index on vector_dims()
  // This allows the query planner to use the index when WHERE includes vector_dims(embedding) = N
  const sql = `
    CREATE INDEX IF NOT EXISTS ${name} ON file_chunks
    USING hnsw ((embedding::vector(${dimension})) vector_cosine_ops)
    WITH (m=${params.m}, ef_construction=${params.ef})
    WHERE vector_dims(embedding) = ${dimension}
  `;

  try {
    await db.exec(sql);
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
 * @param db - PGlite database instance
 * @param dimension - The embedding dimension whose index to drop
 */
export async function dropDimensionIndex(
  db: Pick<PGlite, 'exec'>,
  dimension: number
): Promise<void> {
  const name = indexName(dimension);
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
export async function getDistinctDimensions(db: Pick<PGlite, 'query'>): Promise<number[]> {
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
  db: Pick<PGlite, 'exec' | 'query'>,
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
  db: Pick<PGlite, 'query'>,
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
  db: Pick<PGlite, 'exec'>,
  dimensions: number[]
): Promise<void> {
  for (const dim of dimensions) {
    await dropDimensionIndex(db, dim);
  }
}
