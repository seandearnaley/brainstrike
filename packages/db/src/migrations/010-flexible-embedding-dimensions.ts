import type { Migration } from './migration-runner';

// Migration 010: Allow embedding vectors with arbitrary dimensions.
// Switches file_chunks.embedding from VECTOR(768) to the generic VECTOR type.
export const migration010FlexibleEmbeddingDimensions: Migration = {
  version: 10,
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

    await db.exec(
      'ALTER TABLE file_chunks ALTER COLUMN embedding TYPE vector USING embedding::vector'
    );
  },
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

    await db.exec(
      'ALTER TABLE file_chunks ALTER COLUMN embedding TYPE vector(768) USING embedding::vector(768)'
    );
  },
};
