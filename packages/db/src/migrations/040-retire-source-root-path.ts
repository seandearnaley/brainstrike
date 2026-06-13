import type { Migration } from './migration-runner';

/**
 * Retire file_records.source_root_path: root_id (migration 039) is now the sole
 * managed-cache dedup identity.
 *
 * Sequencing matters for dedup correctness:
 * 1. Backfill any rows that still carry source_root_path but no root_id (writes
 *    that landed between 039 and this migration, before the import path was
 *    guaranteed non-null). Map source_root_path → roots.path → roots.id, the
 *    same join 039 used. 039 stores roots.path as the RAW source_root_path
 *    (only display_name is trimmed), so trailing separators are stripped from
 *    BOTH sides of the join — a trailing-slash root ('/x/') would otherwise
 *    miss the trimmed source side and silently keep root_id NULL. Rows whose
 *    source_root_path matches no root stay NULL and drop out of the managed
 *    cache (they were un-restorable anyway).
 * 2. Drop the 029 indexes (the source_root_path cache identity), then the
 *    column. The 039 root_id identity index (idx_file_records_root_identity)
 *    stays and becomes the only enforced cache identity.
 *
 * Idempotent (IF EXISTS / NULL guards) so a partially-applied run is safe.
 */
export const migration040RetireSourceRootPath: Migration = {
  version: 40,
  name: 'retire_source_root_path',
  up: `
    UPDATE file_records
    SET root_id = roots.id
    FROM roots
    WHERE file_records.root_id IS NULL
      AND file_records.source_root_path IS NOT NULL
      AND regexp_replace(roots.path, '[/\\\\]+$', '')
        = regexp_replace(file_records.source_root_path, '[/\\\\]+$', '');

    DROP INDEX IF EXISTS idx_file_records_cache_identity;
    DROP INDEX IF EXISTS idx_file_records_source_root_path;

    ALTER TABLE file_records
      DROP COLUMN IF EXISTS source_root_path;
  `,
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
};
