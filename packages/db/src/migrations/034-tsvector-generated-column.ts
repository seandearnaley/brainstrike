import type { Migration } from './migration-runner';

/**
 * Migration 034: content_tsvector as a STORED generated column
 *
 * Replaces the trigger-maintained / explicitly-inserted `content_tsvector` with a
 * STORED generated column computed by Postgres from `content`. Benefits:
 * - The tsvector can never drift from `content` (single source of truth).
 * - INSERT/UPSERT statements no longer need to compute `to_tsvector(...)`.
 * - Recreates the GIN index (the drizzle manifest creates the plain column but
 *   not its GIN index, so this also restores fast full-text search).
 *
 * Greenfield contract: the column is dropped and recreated. The DB is wiped on
 * the Postgres 18 upgrade, so there is no data to preserve.
 */
export const migration034TsvectorGeneratedColumn: Migration = {
  // `down` recreates `content_tsvector` as a PLAIN column, restores migration 019's
  // trigger + function (so FUTURE writes stay maintained), AND backfills EXISTING
  // rows (so they aren't left permanently NULL and invisible to `fullTextSearch`,
  // which filters `content_tsvector IS NOT NULL`). A true inverse of `up`, mirroring
  // 019's up (trigger + one-time backfill) — even though the greenfield contract
  // means it's normally only used for dev/test re-migration (the PG18 upgrade wipes
  // the DB).
  down: `
    DROP INDEX IF EXISTS idx_file_chunks_content_tsvector;
    ALTER TABLE file_chunks DROP COLUMN IF EXISTS content_tsvector;
    ALTER TABLE file_chunks ADD COLUMN content_tsvector tsvector;
    CREATE INDEX IF NOT EXISTS idx_file_chunks_content_tsvector
      ON file_chunks USING GIN (content_tsvector);

    -- Restore the v19 trigger so FUTURE writes keep the plain column maintained.
    CREATE OR REPLACE FUNCTION file_chunks_tsvector_trigger()
    RETURNS trigger AS $$
    BEGIN
      NEW.content_tsvector := to_tsvector('english', coalesce(NEW.content, ''));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS file_chunks_tsvector_update ON file_chunks;
    CREATE TRIGGER file_chunks_tsvector_update
      BEFORE INSERT OR UPDATE OF content ON file_chunks
      FOR EACH ROW
      EXECUTE FUNCTION file_chunks_tsvector_trigger();

    -- One-time backfill of EXISTING rows (mirrors migration 019's up), so they are
    -- searchable immediately after rollback rather than only once each is rewritten.
    UPDATE file_chunks
      SET content_tsvector = to_tsvector('english', coalesce(content, ''))
      WHERE content_tsvector IS NULL;
  `,
  ledgerKey: 'custom-034-tsvector-generated-column',
  name: 'tsvector_generated_column',
  up: `
    -- Drop the legacy trigger + function if present (no-op on the drizzle path).
    DROP TRIGGER IF EXISTS file_chunks_tsvector_update ON file_chunks;
    DROP FUNCTION IF EXISTS file_chunks_tsvector_trigger();

    -- Drop the plain column and its index, then recreate as a STORED generated column.
    DROP INDEX IF EXISTS idx_file_chunks_content_tsvector;
    ALTER TABLE file_chunks DROP COLUMN IF EXISTS content_tsvector;
    ALTER TABLE file_chunks
      ADD COLUMN content_tsvector tsvector
      GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;

    -- Recreate the GIN index for fast full-text search.
    CREATE INDEX IF NOT EXISTS idx_file_chunks_content_tsvector
      ON file_chunks USING GIN (content_tsvector);
  `,
  version: 34,
};
