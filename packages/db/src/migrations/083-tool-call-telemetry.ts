import type { Migration } from './migration-runner';

/**
 * Migration 083: durable, privacy-safe per-tool model-output telemetry.
 *
 * NO foreign keys: numbered migrations run without the renderer-lazy assistant
 * run/thread parents. Desktop derives thread ownership from the run row when it
 * inserts; thread deletion and factory reset own cleanup explicitly.
 *
 * `is_pagination_followup` is intentionally only a proxy. We do not persist a
 * search-session correlation key because it would add avoidable pattern/timing
 * correlation risk. The lens divides follow-up calls by first-page calls.
 *
 * `id` uses `crypto.randomUUID()` at the writer, matching the sibling
 * `brainstrike_assistant_run_usage` table — this is a net-new counters ledger
 * outside any sync-related rework, so it is not a uuidv7-groundwork table.
 *
 * Retention (BST-1198): rows older than 60 days are pruned by the existing
 * scheduled-database-maintenance pass (`runScheduledDatabaseMaintenance` in
 * `services/scheduled-database-maintenance.ts`, the same ANALYZE/VACUUM
 * scheduler from #1716) — no separate cron/timer was added. An idle pass does
 * a full age-bounded sweep; a pass while the job queue is active still runs a
 * LIMIT-bounded sweep (mirroring the terminal-job prune split) so a busy
 * queue cannot let telemetry rows accumulate unbounded. The DELETE filters on
 * `occurred_at`, which the existing `tool_id, occurred_at DESC` composite
 * index already covers; an infrequent bounded prune tolerates a full-index or
 * sequential scan, so no dedicated single-column index was added. See
 * docs/agents/database.md for the full contract.
 */
export const migration083ToolCallTelemetry: Migration = {
  down: 'DROP TABLE IF EXISTS brainstrike_tool_call_telemetry;',
  name: 'tool_call_telemetry',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_tool_call_telemetry (
      id text PRIMARY KEY,
      thread_id text NOT NULL,
      run_id text NOT NULL,
      tool_id text NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT NOW(),
      model_facing_chars integer NOT NULL CHECK (model_facing_chars >= 0),
      truncated boolean NOT NULL DEFAULT false,
      zero_match boolean,
      is_pagination_followup boolean NOT NULL DEFAULT false
    );

    CREATE INDEX IF NOT EXISTS brainstrike_tool_call_telemetry_thread_idx
      ON brainstrike_tool_call_telemetry (thread_id);

    CREATE INDEX IF NOT EXISTS brainstrike_tool_call_telemetry_tool_time_idx
      ON brainstrike_tool_call_telemetry (tool_id, occurred_at DESC);
  `,
  version: 83,
};
