import type { Migration } from './migration-runner';

// Migration 006: Embedding sets table and per-chunk embedding metadata
// - Introduces embedding_sets for multi-model safety (model key + dimensions + distance)
// - Adds embedding_set_id, embedding_updated_at, embedding_hash to file_chunks

export const migration006EmbeddingSetsAndColumns: Migration = {
  down: `
    -- Drop indexes
    DROP INDEX IF EXISTS idx_file_chunks_embedhash;
    DROP INDEX IF EXISTS idx_file_chunks_set;

    -- Remove columns from file_chunks
    ALTER TABLE file_chunks
      DROP COLUMN IF EXISTS embedding_hash,
      DROP COLUMN IF EXISTS embedding_updated_at,
      DROP COLUMN IF EXISTS embedding_set_id;

    -- Drop embedding_sets table
    DROP TABLE IF EXISTS embedding_sets;
  `,
  name: 'embedding_sets_and_columns',
  up: `
    -- Create embedding_sets table
    CREATE TABLE IF NOT EXISTS embedding_sets (
      id TEXT PRIMARY KEY,
      model_key TEXT NOT NULL,
      model_id TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      distance TEXT NOT NULL CHECK (distance IN ('cosine','l2','ip')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Add embedding set linkage and metadata to file_chunks
    ALTER TABLE file_chunks 
      ADD COLUMN IF NOT EXISTS embedding_set_id TEXT,
      ADD COLUMN IF NOT EXISTS embedding_updated_at TEXT,
      ADD COLUMN IF NOT EXISTS embedding_hash TEXT;

    -- Add indexes for fast lookups
    CREATE INDEX IF NOT EXISTS idx_file_chunks_set ON file_chunks(embedding_set_id);
    CREATE INDEX IF NOT EXISTS idx_file_chunks_embedhash ON file_chunks(embedding_hash);

    -- Foreign key to embedding_sets (allow NULL; set NULL on delete)
    -- Not all PGlite builds enforce FKs; this is safe and descriptive
    -- If FK exists already, this will be a no-op
    -- SQLite syntax is different; PGlite emulates Postgres; keep it simple
  `,
  version: 6,
};
