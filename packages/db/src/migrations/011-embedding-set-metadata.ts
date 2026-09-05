import type { Migration } from './migration-runner';

// Migration 011: Add user-facing metadata to embedding_sets
// - Adds name, description, tags, category fields
// - Migrates existing sets with default names based on model_key

export const migration011EmbeddingSetMetadata: Migration = {
  down: `
    -- Drop index
    DROP INDEX IF EXISTS idx_embedding_sets_name;

    -- Remove metadata columns
    ALTER TABLE embedding_sets
      DROP COLUMN IF EXISTS category,
      DROP COLUMN IF EXISTS tags,
      DROP COLUMN IF EXISTS description,
      DROP COLUMN IF EXISTS name;
  `,
  ledgerKey: 'custom-011-embedding-set-metadata',
  name: 'embedding_set_metadata',
  up: `
    -- Add user-facing metadata columns to embedding_sets
    ALTER TABLE embedding_sets
      ADD COLUMN IF NOT EXISTS name TEXT,
      ADD COLUMN IF NOT EXISTS description TEXT,
      ADD COLUMN IF NOT EXISTS tags TEXT,
      ADD COLUMN IF NOT EXISTS category TEXT;

    -- Migrate existing sets with default names
    -- If name is NULL, generate from model_key + dimensions
    UPDATE embedding_sets
    SET name = model_key || ' (' || dimensions || 'D)'
    WHERE name IS NULL;

    -- Add index for faster lookups by name
    CREATE INDEX IF NOT EXISTS idx_embedding_sets_name ON embedding_sets(name);
  `,
  version: 11,
};
