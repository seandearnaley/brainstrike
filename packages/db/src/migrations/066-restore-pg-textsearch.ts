import { QUALIFIED_PG_TEXTSEARCH_VERSION } from '../pg-textsearch-compatibility.js';
import type { Migration } from './migration-runner';

/**
 * Migration 066: restore BM25 on the qualified pre-paged-memtable engine.
 *
 * Migration 065 removed pg_textsearch 1.3.1 after it persisted invalid BM25
 * page chains. The PGlite 0.5.3-compatible extension bundle contains 1.2.0,
 * which predates that on-disk paged-memtable design. Fail closed before index
 * creation if packaging ever drifts to a different engine version.
 */
export const migration066RestorePgTextsearch: Migration = {
  down: `
    DROP INDEX IF EXISTS idx_file_chunks_content_bm25;

    DROP EXTENSION IF EXISTS pg_textsearch;
  `,
  name: 'restore_pg_textsearch_1_2',
  up: `
    CREATE EXTENSION IF NOT EXISTS pg_textsearch;

    DO $brainstrike_pg_textsearch_version$
    DECLARE
      actual_version text;
    BEGIN
      SELECT extversion
      INTO actual_version
      FROM pg_extension
      WHERE extname = 'pg_textsearch';

      IF actual_version IS DISTINCT FROM '${QUALIFIED_PG_TEXTSEARCH_VERSION}' THEN
        RAISE EXCEPTION
          'Brainstrike requires qualified pg_textsearch %, but the bundled engine is %; refusing to create the BM25 index',
          '${QUALIFIED_PG_TEXTSEARCH_VERSION}',
          coalesce(actual_version, '<missing>');
      END IF;
    END
    $brainstrike_pg_textsearch_version$;

    CREATE INDEX IF NOT EXISTS idx_file_chunks_content_bm25
      ON file_chunks USING bm25 (content) WITH (text_config='english');
  `,
  version: 66,
};
