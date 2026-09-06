import type { Migration } from './migration-runner';

/**
 * Migration 065: quarantine pg_textsearch after observed on-disk index corruption.
 *
 * pg_textsearch 1.3.1 can persist invalid BM25 memtable page chains while
 * file_chunks rows are updated (originally observed against
 * pglite-pg_textsearch@0.0.5). PostgreSQL then raises XX001 from unrelated
 * writes that maintain idx_file_chunks_content_bm25. Keep the historical 053
 * migration append-only, but remove its index and extension before application
 * writes can begin. Lexical search continues through the built-in generated
 * tsvector + GIN index from migration 034 until migration 066 verifies the
 * qualified engine and restores BM25.
 *
 * BST-1063 (PGlite 0.5.4 bump) re-qualified extension version 1.3.1 itself —
 * see pg-textsearch-compatibility.ts for the qualification evidence and its
 * open gaps. Migration 066 now verifies *that* engine, the same
 * paged-memtable design this migration's corruption report is about, not a
 * "pre-paged-memtable" one; read the two migrations as a pair and don't infer
 * from this docstring alone which engine is currently accepted. One
 * consequence: for a greenfield database, migration 053 creates the BM25
 * index under 1.3.1, this migration drops index + extension, and 066
 * recreates them under that same 1.3.1 engine — a no-op round trip. This
 * migration's only remaining function on a fresh install is to force 066's
 * version guard to be the actual gate, not live protection against a
 * different engine being installed by 053. The history stays append-only by
 * design (squashing is out of scope), so this step is kept even though it no
 * longer "quarantines" anything for new databases.
 *
 * The extension module must remain available at PGlite construction sites
 * until the migration history is squashed: a greenfield database still runs
 * 053 before this migration immediately removes the unsafe objects, then 066
 * creates them again only after its exact engine-version guard passes.
 */
export const migration065QuarantinePgTextsearch: Migration = {
  down: `
    CREATE EXTENSION IF NOT EXISTS pg_textsearch;

    CREATE INDEX IF NOT EXISTS idx_file_chunks_content_bm25
      ON file_chunks USING bm25 (content) WITH (text_config='english');
  `,
  ledgerKey: 'custom-065-quarantine-pg-textsearch',
  name: 'quarantine_pg_textsearch',
  up: `
    DROP INDEX IF EXISTS idx_file_chunks_content_bm25;

    DROP EXTENSION IF EXISTS pg_textsearch;
  `,
  version: 65,
};
