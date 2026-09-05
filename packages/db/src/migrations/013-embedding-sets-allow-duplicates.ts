import type { Migration } from './migration-runner';

export const migration013EmbeddingSetsAllowDuplicates: Migration = {
  down: `
    DROP INDEX IF EXISTS idx_embedding_sets_model_key_created_at;

    ALTER TABLE embedding_sets
      ADD CONSTRAINT embedding_sets_model_key_dimensions_distance_key
        UNIQUE (model_key, dimensions, distance);

    ALTER TABLE embedding_sets
      DROP COLUMN IF EXISTS allow_duplicates;
  `,
  ledgerKey: 'custom-013-embedding-sets-allow-duplicates',
  name: 'embedding_sets_allow_duplicates',
  up: `
    -- Add allow_duplicates column to embedding_sets
    ALTER TABLE embedding_sets
      ADD COLUMN IF NOT EXISTS allow_duplicates BOOLEAN DEFAULT false;

    ALTER TABLE embedding_sets
      DROP CONSTRAINT IF EXISTS embedding_sets_model_key_dimensions_distance_key;

    CREATE INDEX IF NOT EXISTS idx_embedding_sets_model_key_created_at
      ON embedding_sets (model_key, created_at DESC);
  `,
  version: 13,
};
