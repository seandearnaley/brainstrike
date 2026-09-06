import type { Migration } from './migration-runner';

/**
 * Retire file_records.source_root_path: root_id (migration 039) is now the sole
 * managed-cache dedup identity.
 *
 * Sequencing matters for dedup correctness:
 * 1. Backfill any rows that still carry source_root_path but no root_id (writes
 *    that landed between 039 and this migration, before the import path was
 *    guaranteed non-null). Map source_root_path → roots.path → roots.id. 039
 *    stores roots.path as the RAW source_root_path (only display_name is
 *    trimmed) and its unique index is on the raw path, so '/x' and '/x/' can
 *    coexist as two distinct roots. The match is therefore EXACT-FIRST
 *    (deterministic, unique) with a trailing-separator-insensitive fallback,
 *    tie-broken by roots.id — never an arbitrary `UPDATE ... FROM` pick when
 *    both a bare and a trailing-slash root exist for the same directory.
 *    Without the trimmed fallback a trailing-slash root would miss a bare
 *    source and silently keep root_id NULL. Rows whose source_root_path matches
 *    no root stay NULL and drop out of the managed cache (un-restorable anyway).
 * 2. Drop the 029 indexes (the source_root_path cache identity), then the
 *    column. The 039 root_id identity index (idx_file_records_root_identity)
 *    stays and becomes the only enforced cache identity.
 *
 * Idempotent (IF EXISTS / NULL guards) so a partially-applied run is safe.
 */
export const migration040RetireSourceRootPath: Migration = {
  down: `
    ALTER TABLE file_records
      ADD COLUMN IF NOT EXISTS source_root_path TEXT;

    CREATE INDEX IF NOT EXISTS idx_file_records_source_root_path
      ON file_records(source_root_path);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_file_records_cache_identity
      ON file_records(embedding_set_id, source_root_path, path)
      WHERE embedding_set_id IS NOT NULL
        AND source_root_path IS NOT NULL;
  `,
  ledgerKey: 'custom-040-retire-source-root-path',
  name: 'retire_source_root_path',
  up: `
    UPDATE file_records
    SET root_id = (
      SELECT r.id
      FROM roots r
      WHERE regexp_replace(r.path, '[/\\\\]+$', '')
        = regexp_replace(file_records.source_root_path, '[/\\\\]+$', '')
      -- Exact raw-path match wins (boolean DESC puts TRUE first); roots.id is a
      -- stable final tie-break so the pick is never arbitrary.
      ORDER BY (r.path = file_records.source_root_path) DESC, r.id
      LIMIT 1
    )
    WHERE file_records.root_id IS NULL
      AND file_records.source_root_path IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM roots r
        WHERE regexp_replace(r.path, '[/\\\\]+$', '')
          = regexp_replace(file_records.source_root_path, '[/\\\\]+$', '')
      );

    DROP INDEX IF EXISTS idx_file_records_cache_identity;
    DROP INDEX IF EXISTS idx_file_records_source_root_path;

    ALTER TABLE file_records
      DROP COLUMN IF EXISTS source_root_path;
  `,
  version: 40,
};
