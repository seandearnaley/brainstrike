import type { Migration } from './migration-runner';

/**
 * Durable per-run outcome labels (Task Ledger, Phase 1).
 *
 * The run header (`brainstrike_assistant_thread_runs`) already records terminal
 * transport status (completed/failed/cancelled), but transport success says
 * nothing about whether the WORK succeeded. This table stores at most one
 * outcome label per run — the signal the ledger's $/completed-task analytics
 * and later routing recommendations are built on.
 *
 * `verdict` is the label; `source` records where it came from so provenance is
 * never lost (`user` = explicit user verdict, `edit_revert` = derived from the
 * edit-checkpoint journal when a run's edits are reverted, `hook` = reported by
 * a tool-lifecycle hook such as a test runner). Later labels replace earlier
 * ones via upsert on the run_id primary key; `detail` is a short human-readable
 * justification.
 *
 * NO foreign keys (mirrors the run_usage 046 / edit_checkpoints 052 precedent):
 * both migration runners execute on a bare PGlite where the parent
 * `brainstrike_assistant_thread_runs` table is NOT migration-created (it is
 * bootstrapped by the app-shell repository). Like run_usage, outcome rows are
 * analytic facts that outlive thread deletion; factory reset purges the table
 * explicitly (db-ipc.ts OptionalRelationTable).
 *
 * CREATE TABLE IF NOT EXISTS because the dual migration runner creates tables
 * on different paths; the app-shell repository ALSO bootstraps this table, and
 * the two shapes must stay byte-identical.
 */
export const migration062AssistantRunOutcomes: Migration = {
  down: `
    DROP INDEX IF EXISTS brainstrike_assistant_run_outcomes_resource_idx;
    --> statement-breakpoint

    DROP INDEX IF EXISTS brainstrike_assistant_run_outcomes_thread_idx;
    --> statement-breakpoint

    DROP TABLE IF EXISTS brainstrike_assistant_run_outcomes;
  `,
  name: 'assistant_run_outcomes',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_assistant_run_outcomes (
      run_id      text PRIMARY KEY,
      thread_id   text NOT NULL,
      resource_id text NOT NULL,
      verdict     text NOT NULL CHECK (verdict IN ('succeeded','failed','mixed')),
      source      text NOT NULL CHECK (source IN ('user','edit_revert','hook')),
      detail      text,
      labeled_at  timestamptz NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT NOW(),
      updated_at  timestamptz NOT NULL DEFAULT NOW()
    );
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_outcomes_thread_idx
      ON brainstrike_assistant_run_outcomes (thread_id, resource_id);
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_outcomes_resource_idx
      ON brainstrike_assistant_run_outcomes (resource_id, labeled_at DESC);
  `,
  version: 62,
};
