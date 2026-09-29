import type { Migration } from './migration-runner';
import { createVectorIndexes } from './vector-index-helpers.js';

export const migration009VectorIndexTuning: Migration = {
  down: `
    DROP INDEX IF EXISTS idx_file_chunks_embedding_ivf;
    DROP INDEX IF EXISTS idx_file_chunks_embedding_hnsw;
    DROP INDEX IF EXISTS idx_file_chunks_embedding;
  `,
  ledgerKey: 'custom-009-vector-index-tuning',
  name: 'vector_index_tuning',
  up: async (db) => {
    await createVectorIndexes(db);
  },
  version: 9,
};
