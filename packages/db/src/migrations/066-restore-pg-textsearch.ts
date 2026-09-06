import { QUALIFIED_PG_TEXTSEARCH_VERSION } from '../pg-textsearch-compatibility.js';
import type { Migration } from './migration-runner';

/**
 * Migration 066: restore BM25 on the qualified pg_textsearch engine.
 *
 * Migration 065 removed pg_textsearch 1.3.1 after it persisted invalid BM25
 * page chains under pglite-pg_textsearch@0.0.5. BST-1063 re-qualified that
 * same extension version 1.3.1 as bundled by pglite-pg_textsearch@0.0.6 (see
 * pg-textsearch-compatibility.ts for the qualification evidence) after the
 * PGlite 0.5.4 bump forced the whole extension family forward in lockstep.
 * Fail closed before index creation if packaging ever drifts to a different
 * engine version.
 */
export const migration066RestorePgTextsearch: Migration = {
  down: `
    DROP INDEX IF EXISTS idx_file_chunks_content_bm25;

    DROP EXTENSION IF EXISTS pg_textsearch;
  `,
  ledgerKey: 'custom-066-restore-pg-textsearch',
  // The "_1_2" suffix is historical, kept only to avoid churn — renaming it
  // has NO ledger consequence for any database (#2206 review, verified):
  // the Drizzle ledger keys on the `custom-066-...` id + content hash in
  // drizzle/migrate.ts and never persists this field, and the numbered
  // runner dedups on `version` (name lands in a column; the checksum only
  // folds `name` in when `up` is a function, and 066's is a string). A
  // drift failure therefore reports `restore_pg_textsearch_1_2` while
  // demanding 1.3.1 — cosmetic history, not evidence of a stale edit.
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
