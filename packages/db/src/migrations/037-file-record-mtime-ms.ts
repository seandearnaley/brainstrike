import type { Migration } from './migration-runner';

/**
 * Adds a nullable `mtime_ms` column to `file_records` so background indexing can
 * run a stat-cache fast-path: when a discovered file's size AND mtime both match
 * the stored values, the file is treated as unchanged without reading/hashing its
 * content. The column is nullable because rows written before this migration have
 * no recorded mtime — those rows fall through to the read+hash path and persist an
 * mtime on their next write, so the optimization self-heals on rollout.
 *
 * BIGINT (not INTEGER): epoch milliseconds (~1.7e12) exceed the INT4 range. This
 * mirrors the existing `file_token_cache.mtime_ms` column.
 */
export const migration037FileRecordMtimeMs: Migration = {
  version: 37,
  name: 'file_record_mtime_ms',
  up: `
    ALTER TABLE IF EXISTS file_records
      ADD COLUMN IF NOT EXISTS mtime_ms BIGINT;
  `,
  down: `
    ALTER TABLE IF EXISTS file_records
      DROP COLUMN IF EXISTS mtime_ms;
  `,
};
