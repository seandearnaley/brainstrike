import type { Migration } from './migration-runner';

/**
 * Cross-root cost aggregation (Phase 5.2).
 *
 * Adds a nullable `root_id` to `brainstrike_assistant_run_usage` so durable
 * token usage can be grouped by workspace ROOT (not just thread). root_id is
 * captured at REQUEST START — the focused-root identity, like the model, can
 * change mid-run, so it is snapshotted with the run, never read at finish time.
 *
 * Nullable on purpose: a turn with no focused root stores NULL (an honest
 * "unattributed" bucket — there is no silent fallback to a fake root). The
 * value is the client adapter RootId, which equals `roots.id` for roots
 * registered through reconcileRoots; legacy path-matched roots can diverge, in
 * which case the cost panel's LEFT JOIN simply misses and renders a truncated
 * id (still honest — never a wrong name).
 *
 * ADD COLUMN / CREATE INDEX are IF [NOT] EXISTS because the dual migration
 * runner (numbered runner for tests, drizzle customMigrations for the real
 * app) runs on different paths, and the desktop repository ALSO bootstraps the
 * same column + index on first write — all three must converge on one shape.
 */
export const migration047RunUsageRootId: Migration = {
  down: `
    DROP INDEX IF EXISTS brainstrike_assistant_run_usage_root_idx;
    --> statement-breakpoint

    ALTER TABLE IF EXISTS brainstrike_assistant_run_usage
      DROP COLUMN IF EXISTS root_id;
  `,
  ledgerKey: 'custom-047-run-usage-root-id',
  name: 'run_usage_root_id',
  up: `
    ALTER TABLE IF EXISTS brainstrike_assistant_run_usage
      ADD COLUMN IF NOT EXISTS root_id text;
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_usage_root_idx
      ON brainstrike_assistant_run_usage (resource_id, root_id);
  `,
  version: 47,
};
