import type { Migration } from './migration-runner';

/**
 * Migration 048: trigram GIN index on file_records.name for ⌘P quick-open.
 *
 * Powers the quick-open file finder (PR-6.3): the name fuzzy-find query
 * (`findByNameSubstring`) uses `name ILIKE '%...%'`, which becomes an index scan
 * instead of a sequential scan with this trigram index. The pg_trgm extension
 * is already enabled (migration 038), so this migration only adds the index.
 *
 * CREATE INDEX is IF NOT EXISTS because the dual migration runner (numbered
 * runner for tests, drizzle customMigrations for the real app) runs on
 * different paths — both must converge on the same index shape.
 */
export const migration048FileRecordsNameTrgm: Migration = {
  version: 48,
  name: 'file_records_name_trgm',
  up: `
    CREATE INDEX IF NOT EXISTS idx_file_records_name_trgm
      ON file_records USING gin (name gin_trgm_ops);
  `,
  down: `
    DROP INDEX IF EXISTS idx_file_records_name_trgm;
  `,
};
