import type { Migration } from './migration-runner';

/**
 * Migration 081: `brainstrike_workspace_snapshots` — the shadow-git snapshot
 * ledger (BST-1164, W7 T1).
 *
 * One row per snapshot commit taken in a workspace root's SHADOW git repo
 * (`userData/snapshots/<rootId>/git`, see
 * `apps/desktop/src/assistant-server/snapshot-service.ts`). The table is the
 * source of truth for the turn↔commit-oid mapping; the shadow
 * `refs/snapshots/<threadId>` refs exist only to keep objects alive for GC.
 *
 * Column semantics:
 * - `id` is an app-side uuidv7 (`snapshot-repository.ts` mints it — migration
 *   080's caller-supplied-text-PK convention, uuidv7 per the sync-groundwork
 *   ruling so ids stay time-sortable).
 * - `run_id` is NULLABLE on purpose: a turn is NOT a run (approval resumes
 *   mint new run rows — the deleted-file incident class), so a snapshot is
 *   anchored to its thread and records the triggering run only as provenance.
 * - `root_path` captures the root's canonicalized path at snapshot time:
 *   root_id→path is unrecoverable once the `roots` row is gone, and restore
 *   must refuse (visibly) when the recorded path no longer matches.
 * - `kind` is CHECK-constrained (migration 079's closed-vocabulary
 *   convention): widening it is a conscious migration, not a drift channel.
 *
 * NO foreign keys (migration 055/080 precedent): numbered migrations run
 * against a bare schema with no Mastra thread/run parents present, and
 * `roots` rows outlive/predate snapshots independently.
 */
export const migration081WorkspaceSnapshots: Migration = {
  down: 'DROP TABLE IF EXISTS brainstrike_workspace_snapshots;',
  ledgerKey: 'custom-081-workspace-snapshots',
  name: 'workspace_snapshots',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_workspace_snapshots (
      id text PRIMARY KEY,
      thread_id text NOT NULL,
      run_id text,
      root_id text NOT NULL,
      root_path text NOT NULL,
      commit_oid text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('turn-start', 'turn-end', 'pre-revert')),
      created_at timestamptz NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS brainstrike_workspace_snapshots_thread_idx
      ON brainstrike_workspace_snapshots (thread_id, created_at);

    CREATE INDEX IF NOT EXISTS brainstrike_workspace_snapshots_root_idx
      ON brainstrike_workspace_snapshots (root_id);
  `,
  version: 81,
};
