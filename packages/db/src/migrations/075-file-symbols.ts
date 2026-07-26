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
 * `embedding_set_id` is denormalized with the same dual-form scoping contract
 * as `file_chunks` (legacy rows may be NULL; scoped queries must fall back to
 * the file_records join — `electron-file-chunk-repository.ts:669`).
 *
 * The `brainstrike_agent_readonly` role reads these tables via migration 074's
 * `ALTER DEFAULT PRIVILEGES`; `file-symbols.test.ts` pins that instead of
 * assuming it.
 */
export const migration075FileSymbols: Migration = {
  down: `
    DROP INDEX IF EXISTS idx_file_symbol_refs_from_symbol_id;
    --> statement-breakpoint
    DROP INDEX IF EXISTS idx_file_symbol_refs_file_record_id;
    --> statement-breakpoint
    DROP INDEX IF EXISTS idx_file_symbol_refs_embedding_set_id;
    --> statement-breakpoint
    DROP INDEX IF EXISTS idx_file_symbol_refs_name;
    --> statement-breakpoint
    DROP TABLE IF EXISTS file_symbol_refs;
    --> statement-breakpoint
    DROP INDEX IF EXISTS idx_file_symbols_embedding_set_id;
    --> statement-breakpoint
    DROP INDEX IF EXISTS idx_file_symbols_file_record_id;
    --> statement-breakpoint
    DROP INDEX IF EXISTS idx_file_symbols_name;
    --> statement-breakpoint
    DROP TABLE IF EXISTS file_symbols;
  `,
  name: 'file_symbols',
  up: `
    CREATE TABLE IF NOT EXISTS file_symbols (
      id               text PRIMARY KEY,
      file_record_id   text NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
      embedding_set_id text,
      name             text NOT NULL,
      kind             text NOT NULL CHECK (kind IN ('function','class','method','variable','interface','type','enum')),
      exported         boolean NOT NULL DEFAULT false,
      start_line       integer NOT NULL,
      end_line         integer NOT NULL,
      start_offset     integer NOT NULL,
      end_offset       integer NOT NULL,
      created_at       timestamptz NOT NULL DEFAULT NOW()
    );
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS idx_file_symbols_name ON file_symbols (name);
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS idx_file_symbols_file_record_id ON file_symbols (file_record_id);
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS idx_file_symbols_embedding_set_id ON file_symbols (embedding_set_id);
    --> statement-breakpoint
    CREATE TABLE IF NOT EXISTS file_symbol_refs (
      id               text PRIMARY KEY,
      file_record_id   text NOT NULL REFERENCES file_records(id) ON DELETE CASCADE,
      embedding_set_id text,
      from_symbol_id   text REFERENCES file_symbols(id) ON DELETE CASCADE,
      name             text NOT NULL,
      kind             text NOT NULL CHECK (kind IN ('call','import','extends','implements')),
      module           text,
      line             integer NOT NULL,
      created_at       timestamptz NOT NULL DEFAULT NOW()
    );
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS idx_file_symbol_refs_name ON file_symbol_refs (name);
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS idx_file_symbol_refs_file_record_id ON file_symbol_refs (file_record_id);
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS idx_file_symbol_refs_embedding_set_id ON file_symbol_refs (embedding_set_id);
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS idx_file_symbol_refs_from_symbol_id ON file_symbol_refs (from_symbol_id);
  `,
  version: 75,
};
