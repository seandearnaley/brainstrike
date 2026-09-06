import type { Migration } from './migration-runner';

/**
 * Migration 109 (BST-1390, W3): the managed-worktree ledger — one row per
 * linked git worktree BrainStrike created, by user action or by an agent tool.
 *
 * DELIBERATE OMISSIONS, so a reviewer does not have to ask:
 *
 * - NO `root_id` column, despite the design spec listing one. The durable
 *   `roots.id` is derived by PATH from the live `roots` table at read time
 *   (`WorktreeService.list`). A stored copy is a second source of truth that
 *   goes stale the instant the user disconnects that folder.
 * - NO foreign keys. The numbered runner runs on a bare PGlite without the
 *   Mastra parents (same rule migration 095 records), and a worktree
 *   deliberately OUTLIVES its thread — cascading it away on thread delete
 *   would silently orphan a directory full of the user's work on disk.
 * - NOT in `THREAD_DELETE_SIDECAR_TABLES` for that same reason. Thread delete
 *   offers "also archive its worktree" as an explicit action instead.
 * - Was never mirrored in the retired renderer bootstrap: that mirror existed
 *   only because the thread-delete CTE references every registered sidecar
 *   unconditionally, and this table is not one.
 *
 * Registered in BOTH runners (numbered + drizzle `customMigrations`) and in the
 * reset registry — see docs/agents/database.md.
 */
export const migration109Worktrees: Migration = {
  down: 'DROP TABLE IF EXISTS brainstrike_worktrees;',
  ledgerKey: 'custom-109-worktrees',
  name: 'worktrees',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_worktrees (
      id text PRIMARY KEY,
      repo_common_dir text NOT NULL,
      path text NOT NULL UNIQUE,
      branch text,
      base_ref text NOT NULL,
      created_by text NOT NULL CHECK (created_by IN ('agent', 'user')),
      thread_id text,
      run_id text,
      setup_status text NOT NULL DEFAULT 'none'
        CHECK (setup_status IN ('failed', 'none', 'skipped', 'succeeded')),
      setup_output text,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      archived_at timestamptz,
      archive_snapshot_ref text,
      CONSTRAINT brainstrike_worktrees_archive_consistency
        CHECK ((archived_at IS NULL) = (archive_snapshot_ref IS NULL))
    );

    -- The hot read: "every LIVE worktree of this repository", issued on every
    -- picker open and every create (name-collision check).
    CREATE INDEX IF NOT EXISTS brainstrike_worktrees_repo_active_idx
      ON brainstrike_worktrees (repo_common_dir)
      WHERE archived_at IS NULL;

    CREATE INDEX IF NOT EXISTS brainstrike_worktrees_thread_idx
      ON brainstrike_worktrees (thread_id);
  `,
  version: 109,
};
