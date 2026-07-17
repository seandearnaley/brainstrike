import type { Migration } from './migration-runner';
import { createVectorIndexes, dropExistingVectorIndexes } from './vector-index-helpers.js';

// Migration 010: Allow embedding vectors with arbitrary dimensions.
// Switches file_chunks.embedding from VECTOR(768) to the generic VECTOR type.
export const migration010FlexibleEmbeddingDimensions: Migration = {
  down: async (db) => {
    const columnCheck = await db.query<{ count: number }>(
      `
        SELECT COUNT(*) AS count
        FROM information_schema.columns
        WHERE table_name = 'file_chunks' AND column_name = 'embedding'
      `
    );
    const hasEmbeddingColumn = Number(columnCheck.rows?.[0]?.count ?? 0) > 0;
    if (!hasEmbeddingColumn) {
      return;
    }

    try {
      await dropExistingVectorIndexes(db);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to drop vector indexes before restoring 768D column: ${message}`);
    }

    try {
      await db.exec(
        'ALTER TABLE file_chunks ALTER COLUMN embedding TYPE vector(768) USING embedding::vector(768)'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to restore file_chunks.embedding to vector(768): ${message}`);
    }

    try {
      await createVectorIndexes(db);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to recreate vector indexes after restoring 768D column: ${message}`);
    }
  },
  name: 'flexible_embedding_dimensions',
  up: async (db) => {
    const columnCheck = await db.query<{ count: number }>(
      `
        SELECT COUNT(*) AS count
        FROM information_schema.columns
        WHERE table_name = 'file_chunks' AND column_name = 'embedding'
      `
    );
    const hasEmbeddingColumn = Number(columnCheck.rows?.[0]?.count ?? 0) > 0;
    if (!hasEmbeddingColumn) {
      return;
    }

    try {
      await dropExistingVectorIndexes(db);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to drop vector indexes before widening embedding column: ${message}`);
    }

    try {
      await db.exec(
        'ALTER TABLE file_chunks ALTER COLUMN embedding TYPE vector USING embedding::vector'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to alter file_chunks.embedding to dimensionless vector type: ${message}`
      );
    }

    // Intentionally leave vector indexes absent until per-dimension indexes are introduced.
    // With a dimensionless column, pgvector cannot build ANN indexes. See brainstrike-40.
  },
  version: 10,
};
