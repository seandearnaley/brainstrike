import type { Migration } from './migration-runner';

/**
 * Multi-root phase 1 (inert): first-class roots table + file_records.root_id.
 *
 * Backfills one root per distinct source_root_path as kind 'legacy' — the
 * platform adapter reconciles legacy roots into 'path' (desktop) or 'fsa'
 * (web) on first restore in phase 2; SQL cannot know the platform.
 *
 * display_name strips everything up to the last '/' or '\\'; web legacy
 * values are bare folder names (no separator) and pass through unchanged.
 * Degenerate roots ('/' or 'C:\\') would strip to '' — NULLIF/COALESCE
 * falls back to the full path so display_name is never empty.
 *
 * The 029 index (embedding_set_id, source_root_path, path) stays in place
 * until writes populate root_id (phase 3); both identities are enforced
 * during the transition.
 */
export const migration039RootsTable: Migration = {
  version: 39,
  name: 'roots_table',
  up: `
    CREATE TABLE IF NOT EXISTS roots (
      id TEXT PRIMARY KEY DEFAULT (uuidv7()::text),
      kind TEXT NOT NULL CHECK (kind IN ('path', 'fsa', 'snapshot', 'legacy')),
      display_name TEXT NOT NULL,
      path TEXT,
      status TEXT NOT NULL DEFAULT 'live'
        CHECK (status IN ('live', 'needs-regrant', 'disconnected', 'snapshot-stale')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_verified_at TIMESTAMPTZ
    );
    --> statement-breakpoint

    CREATE UNIQUE INDEX IF NOT EXISTS idx_roots_path
      ON roots(path)
      WHERE path IS NOT NULL;
    --> statement-breakpoint

    -- cascade intentional: root removal is a full workspace wipe
    ALTER TABLE IF EXISTS file_records
      ADD COLUMN IF NOT EXISTS root_id TEXT REFERENCES roots(id) ON DELETE CASCADE;
    --> statement-breakpoint

    INSERT INTO roots (kind, display_name, path)
    SELECT
      'legacy',
      COALESCE(
        NULLIF(regexp_replace(s.source_root_path, '^.*[/\\\\]', ''), ''),
        s.source_root_path
      ),
      s.source_root_path
    FROM (
      SELECT DISTINCT source_root_path
      FROM file_records
      WHERE source_root_path IS NOT NULL
    ) AS s
    ON CONFLICT (path) WHERE path IS NOT NULL DO NOTHING;
    --> statement-breakpoint

    UPDATE file_records
    SET root_id = roots.id
    FROM roots
    WHERE file_records.source_root_path IS NOT NULL
      AND roots.path = file_records.source_root_path
      AND file_records.root_id IS NULL;
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS idx_file_records_root_id
      ON file_records(root_id);
    --> statement-breakpoint

    CREATE UNIQUE INDEX IF NOT EXISTS idx_file_records_root_identity
      ON file_records(embedding_set_id, root_id, path)
      WHERE embedding_set_id IS NOT NULL
        AND root_id IS NOT NULL;
  `,
  down: `
    DROP INDEX IF EXISTS idx_file_records_root_identity;
    DROP INDEX IF EXISTS idx_file_records_root_id;

    ALTER TABLE IF EXISTS file_records
      DROP COLUMN IF EXISTS root_id;

    DROP TABLE IF EXISTS roots;
  `,
};
