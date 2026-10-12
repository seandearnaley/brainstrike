import type { Migration } from './migration-runner';

/**
 * Migration 075: the symbol graph (BST-919).
 *
 * Symbol definitions and name-based references extracted at chunking time, so
 * `brainstrike.querySelf` can answer structural questions ("transitive callers
 * of X") with one recursive CTE instead of an agentic tool loop. Design and
 * settled rulings: `docs/superpowers/plans/2026-07-26-symbol-graph.md`.
 *
 * REFS STORE NAMES, NOT RESOLVED SYMBOL IDS — a ruling, not a shortcut.
 * Symbol rows share the chunk lifecycle: hard-deleted and re-inserted on every
 * file edit. A stored cross-file `to_symbol_id` would dangle after every
 * re-index of the target file. The name join (`refs.name = symbols.name`) is
 * stable under that churn by construction, and over-connecting (two `render`s
 * alias) is the correct failure direction for a retrieval index — extra
 * candidates, never a silently missing edge.
 *
 * `from_symbol_id` (the ENCLOSING definition of a ref) is a real id, but it
 * only ever points into the same file's extraction batch, inserted in the same
 * transaction — so its FK can never dangle across files. ON DELETE CASCADE on
 * both FKs handles file deletion; the managed-cache REPLACE path deletes
 * explicitly because the file_records row survives an edit (see
 * `applyManagedCacheReplacements`).
 *
 * The (name) indexes are the graph: the recursive traversal joins on name once
 * per recursion level, and without them each level is a seq scan whose planner
 * cost blows past the querySelf admission ceiling on a real workspace.
 *
 * There is deliberately NO embedding_set_id column: scoped queries join
 * through file_records (the root-scoping precedent — file_chunks has no
 * root_id column either). Carrying the uuid text on every row, unindexed and
 * unqueried, measured at ~4-5 MB of pure cost on this monorepo — the one
 * combination that only loses (#2032 review).
 *
 * The `brainstrike_agent_readonly` role read these tables through migration
 * 074's `ALTER DEFAULT PRIVILEGES` until migration 151 dropped it.
 *
 * STORAGE SHAPE IS MEASURED, NOT GUESSED. v1 of this migration used text ids
 * (`${fileRecordId}_sym_${n}`) with per-column secondary indexes; measured on
 * this monorepo (3,337 TS files, 22,920 symbols, 109,297 refs) the graph cost
 * 28.2 MB — ~98% of raw source bytes — with the text PKs and redundant
 * indexes as the dominant cost. This shape replaces them with composite
 * integer PKs: (file_record_id, seq). The PK's leading column doubles as the
 * per-file lookup index (deletion path), and embedding-set scoping joins
 * through file_records exactly like root scoping does for file_chunks —
 * `file_chunks` has no root_id column either. Re-measured: see the PR.
 */
export const migration075FileSymbols: Migration = {
  down: `
    DROP INDEX IF EXISTS idx_file_symbol_refs_name_kind;
    --> statement-breakpoint
    DROP TABLE IF EXISTS file_symbol_refs;
    --> statement-breakpoint
    DROP INDEX IF EXISTS idx_file_symbols_name;
    --> statement-breakpoint
    DROP TABLE IF EXISTS file_symbols;
  `,
  ledgerKey: 'custom-075-file-symbols',
  name: 'file_symbols',
  up: `
    CREATE TABLE IF NOT EXISTS file_symbols (
      file_record_id   text NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
      seq              integer NOT NULL,
      name             text NOT NULL,
      kind             text NOT NULL CHECK (kind IN ('function','class','method','variable','interface','type','enum')),
      exported         boolean NOT NULL DEFAULT false,
      start_line       integer NOT NULL,
      end_line         integer NOT NULL,
      start_offset     integer NOT NULL,
      end_offset       integer NOT NULL,
      PRIMARY KEY (file_record_id, seq)
    );
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS idx_file_symbols_name ON file_symbols (name);
    --> statement-breakpoint
    CREATE TABLE IF NOT EXISTS file_symbol_refs (
      file_record_id   text NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
      seq              integer NOT NULL,
      from_symbol_seq  integer,
      name             text NOT NULL,
      kind             text NOT NULL CHECK (kind IN ('call','import','extends','implements')),
      module           text,
      line             integer NOT NULL,
      PRIMARY KEY (file_record_id, seq),
      FOREIGN KEY (file_record_id, from_symbol_seq)
        REFERENCES file_symbols (file_record_id, seq) ON DELETE CASCADE
    );
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS idx_file_symbol_refs_name_kind ON file_symbol_refs (name, kind);
    --> statement-breakpoint
    -- BACKFILL: files chunked before this migration would otherwise never be
    -- re-chunked (unchanged size/mtime = stat-cache hit), leaving the symbol
    -- graph permanently empty on upgraded installs. chunks_processed_at = NULL
    -- is the background sync's re-chunk marker; re-chunking upserts chunks in
    -- place (same ids for unchanged content) and re-embedding is served by
    -- embedding_cache, so the reset costs one re-chunk pass, not a re-embed.
    UPDATE file_records
       SET chunks_processed_at = NULL,
           chunking_strategy = NULL
     WHERE chunks_processed_at IS NOT NULL
       AND content IS NOT NULL;
  `,
  version: 75,
};
