import {
  createDimensionIndex,
  dropAllDimensionIndexes,
  getDistinctDimensions,
  hnswParams,
} from './dimension-index-helpers.js';
import type { Migration, MigrationTransactionalDb } from './migration-runner';

/**
 * Common embedding dimensions to pre-create indexes for.
 * These cover the most popular embedding models:
 * - 768: Legacy default, Jina models, some BERT variants
 * - 1024: BGE-M3, Cohere embed-multilingual-v3.0
 * - 1536: OpenAI text-embedding-3-small, text-embedding-ada-002
 */
const COMMON_DIMENSIONS = [768, 1024, 1536] as const;

/**
 * Migration 014: Create HNSW indexes per embedding dimension.
 *
 * This migration addresses the issue where migration 010 dropped vector indexes
 * after converting file_chunks.embedding to dimensionless VECTOR type.
 *
 * Strategy: Use partial indexes with expression casting to create dimension-specific
 * HNSW indexes. The query planner uses these when WHERE includes vector_dims(embedding) = N.
 *
 * Example index created:
 * ```sql
 * CREATE INDEX idx_file_chunks_emb_hnsw_1024 ON file_chunks
 *   USING hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops)
 *   WITH (m=16, ef_construction=64)
 *   WHERE vector_dims(embedding) = 1024;
 * ```
 */
export const migration014DimensionHnswIndexes: Migration = {
  down: async (db: MigrationTransactionalDb) => {
    // Collect all dimensions that might have indexes
    const dimensionsToClean = new Set<number>([...COMMON_DIMENSIONS]);

    // Also include any existing dimensions from embedding_sets
    try {
      const existingDimensions = await getDistinctDimensions(db);
      for (const dim of existingDimensions) {
        dimensionsToClean.add(dim);
      }
    } catch {
      // embedding_sets table might not exist during rollback
    }

    // Drop all dimension-based indexes
    await dropAllDimensionIndexes(db, [...dimensionsToClean]);
  },
  name: 'dimension_hnsw_indexes',
  up: async (db: MigrationTransactionalDb) => {
    // Check if pgvector extension is available
    const vectorCheck = await db.query<{ one: number }>(
      "SELECT 1 as one FROM pg_extension WHERE extname = 'vector'"
    );
    if (!vectorCheck.rows?.length) {
      // pgvector not available, skip index creation
      // This allows the migration to succeed in environments without pgvector
      return;
    }

    // Check if file_chunks table exists
    const tableCheck = await db.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM information_schema.tables
       WHERE table_name = 'file_chunks'`
    );
    if (Number(tableCheck.rows?.[0]?.count ?? 0) === 0) {
      // Table doesn't exist yet, skip (will be created in future migration)
      return;
    }

    // Get HNSW tuning parameters from environment
    const params = hnswParams();

    // Create indexes for common dimensions
    for (const dim of COMMON_DIMENSIONS) {
      await createDimensionIndex(db, dim, params);
    }

    // Also create indexes for any dimensions already in use by embedding sets
    const existingDimensions = await getDistinctDimensions(db);
    for (const dim of existingDimensions) {
      // Skip if already covered by common dimensions
      if (!COMMON_DIMENSIONS.includes(dim as (typeof COMMON_DIMENSIONS)[number])) {
        await createDimensionIndex(db, dim, params);
      }
    }
  },
  version: 14,
};
