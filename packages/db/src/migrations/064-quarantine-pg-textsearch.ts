import type { Migration } from './migration-runner';

/**
 * Migration 064: quarantine pg_textsearch after observed on-disk index corruption.
 *
 * pg_textsearch 1.3.1 can persist invalid BM25 memtable page chains while
 * file_chunks rows are updated. PostgreSQL then raises XX001 from unrelated
 * writes that maintain idx_file_chunks_content_bm25. Keep the historical 053
 * migration append-only, but remove its index and extension before application
 * writes can begin. Lexical search continues through the built-in generated
 * tsvector + GIN index from migration 034.
 *
 * The extension module must remain available at PGlite construction sites
 * until the migration history is squashed: a greenfield database still runs
 * 053 before this migration immediately removes the unsafe objects.
 */
export const migration064QuarantinePgTextsearch: Migration = {
  down: `
    CREATE EXTENSION IF NOT EXISTS pg_textsearch;

    CREATE INDEX IF NOT EXISTS idx_file_chunks_content_bm25
      ON file_chunks USING bm25 (content) WITH (text_config='english');
  `,
  name: 'quarantine_pg_textsearch',
  up: `
    DROP INDEX IF EXISTS idx_file_chunks_content_bm25;

    DROP EXTENSION IF EXISTS pg_textsearch;
  `,
  version: 64,
};
