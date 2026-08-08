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
