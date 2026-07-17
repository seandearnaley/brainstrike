import type { Migration } from './migration-runner';

/**
 * Migration 019: Add tsvector column and GIN index for full-text search (BST-290)
 *
 * This migration enables PostgreSQL full-text search on the file_chunks table:
 * 1. Adds content_tsvector column to store pre-computed tsvector
 * 2. Creates GIN index for fast full-text search queries
 * 3. Creates trigger to auto-update tsvector when content changes
 * 4. Populates existing rows with tsvector data
 *
 * The tsvector column enables:
 * - Fast full-text search using ts_query
 * - Ranking with ts_rank / ts_rank_cd
 * - Hybrid search combining vector similarity with keyword matching (RRF)
 */

export const migration019FtsTsvectorColumn: Migration = {
  down: `
    -- Remove trigger first
    DROP TRIGGER IF EXISTS file_chunks_tsvector_update ON file_chunks;

    -- Remove trigger function
    DROP FUNCTION IF EXISTS file_chunks_tsvector_trigger();

    -- Remove GIN index
    DROP INDEX IF EXISTS idx_file_chunks_content_tsvector;

    -- Remove tsvector column
    ALTER TABLE file_chunks
      DROP COLUMN IF EXISTS content_tsvector;
  `,
  name: 'fts_tsvector_column',
  up: `
    -- Add tsvector column for full-text search
    -- Using 'english' configuration for stemming, stop words, etc.
    ALTER TABLE file_chunks
      ADD COLUMN IF NOT EXISTS content_tsvector tsvector;

    -- Create GIN index for fast full-text search
    -- GIN (Generalized Inverted Index) is optimized for tsvector queries
    CREATE INDEX IF NOT EXISTS idx_file_chunks_content_tsvector
      ON file_chunks USING GIN (content_tsvector);

    -- Create trigger function to auto-update tsvector on content changes
    CREATE OR REPLACE FUNCTION file_chunks_tsvector_trigger()
    RETURNS trigger AS $$
    BEGIN
      -- Use 'english' config for stemming and stop word removal
      -- coalesce handles NULL content gracefully
      NEW.content_tsvector := to_tsvector('english', coalesce(NEW.content, ''));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    -- Create trigger to fire on INSERT or UPDATE of content
    DROP TRIGGER IF EXISTS file_chunks_tsvector_update ON file_chunks;
    CREATE TRIGGER file_chunks_tsvector_update
      BEFORE INSERT OR UPDATE OF content ON file_chunks
      FOR EACH ROW
      EXECUTE FUNCTION file_chunks_tsvector_trigger();

    -- Populate existing rows with tsvector data
    -- This may take time on large datasets but is idempotent
    UPDATE file_chunks
      SET content_tsvector = to_tsvector('english', coalesce(content, ''))
      WHERE content_tsvector IS NULL;
  `,
  version: 19,
};
