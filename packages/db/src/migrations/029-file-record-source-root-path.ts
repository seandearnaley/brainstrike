import type { Migration } from './migration-runner';

export const migration029FileRecordSourceRootPath: Migration = {
  down: `
    DROP INDEX IF EXISTS idx_file_records_cache_identity;
    DROP INDEX IF EXISTS idx_file_records_source_root_path;

    ALTER TABLE file_records
      DROP COLUMN IF EXISTS source_root_path;
  `,
  name: 'file_record_source_root_path',
  up: `
    ALTER TABLE file_records
      ADD COLUMN IF NOT EXISTS source_root_path TEXT;

    CREATE INDEX IF NOT EXISTS idx_file_records_source_root_path
      ON file_records(source_root_path);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_file_records_cache_identity
      ON file_records(embedding_set_id, source_root_path, path)
      WHERE embedding_set_id IS NOT NULL
        AND source_root_path IS NOT NULL;
  `,
  version: 29,
};
