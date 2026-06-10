import type { Migration } from './migration-runner';

/**
 * Migration 038: Enable pg_trgm and add a trigram GIN index for grep-style search
 *
 * Powers the brainstrike.grepSearch tool: substring (ILIKE '%...%') and
 * regex-literal prefilter queries on file_chunks.content become index scans
 * instead of sequential scans. Requires the pg_trgm extension module to be
 * passed to the PGlite constructor (see wasm-loader.ts / pglite-worker-entry.ts /
 * apps/desktop/src/db-main.ts) before CREATE EXTENSION can succeed.
 */

export const migration038PgTrgmGrepIndex: Migration = {
  version: 38,
  name: 'pg_trgm_grep_index',
  up: `
    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    CREATE INDEX IF NOT EXISTS idx_file_chunks_content_trgm
      ON file_chunks USING gin (content gin_trgm_ops);
  `,
  down: `
    DROP INDEX IF EXISTS idx_file_chunks_content_trgm;

    DROP EXTENSION IF EXISTS pg_trgm;
  `,
};
