import type { Migration } from './migration-runner';

/**
 * Migration 053: Enable pg_textsearch and add a BM25 index on file_chunks.content
 *
 * Powers the BM25 lexical arm of hybrid search: fullTextSearch keeps its
 * tsvector match semantics (WHERE content_tsvector @@ ...) and orders by
 * negated BM25 score via `content <@> to_bm25query($q, 'idx_file_chunks_content_bm25')`,
 * which REQUIRES this index to exist by name — the repositories error without
 * it, so this migration must ship in the same release as the repository swap.
 *
 * Built inline (not deferred like the HNSW dimension indexes): the empirical
 * gate (search-bm25-empirical-gate.test.ts) measured the build at ~0.5 s for
 * 50k chunks, far under the 15–20 s budget that motivated HNSW deferral, and
 * a missing bm25 index is a query ERROR rather than a graceful seq-scan
 * degradation, so deferral would force index-existence branching in every
 * repository. Requires the pg_textsearch extension module to be passed to the
 * PGlite constructor (see wasm-loader.ts / pglite-worker-entry.ts /
 * browser-first-run-bootstrap-worker.ts / apps/desktop/src/db-main.ts) before
 * CREATE EXTENSION can succeed.
 */

export const migration053Bm25ContentIndex: Migration = {
  // The extension is dropped here ONLY because 053 is its sole consumer today.
  // If a later migration adds another pg_textsearch-dependent object, its down
  // must not rely on this one dropping the extension — and this DROP EXTENSION
  // (deliberately without CASCADE) will fail loudly rather than silently
  // dropping that dependent object.
  down: `
    DROP INDEX IF EXISTS idx_file_chunks_content_bm25;

    DROP EXTENSION IF EXISTS pg_textsearch;
  `,
  name: 'bm25_content_index',
  up: `
    CREATE EXTENSION IF NOT EXISTS pg_textsearch;

    CREATE INDEX IF NOT EXISTS idx_file_chunks_content_bm25
      ON file_chunks USING bm25 (content) WITH (text_config='english');
  `,
  version: 53,
};
