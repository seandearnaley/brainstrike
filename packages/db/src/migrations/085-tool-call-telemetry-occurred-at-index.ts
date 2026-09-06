import type { Migration } from './migration-runner';

/**
 * Migration 085: dedicated `occurred_at`-leading index for
 * `brainstrike_tool_call_telemetry` retention pruning (BST-1198 review
 * follow-up).
 *
 * Migration 083's `brainstrike_tool_call_telemetry_tool_time_idx` is
 * `(tool_id, occurred_at DESC)` — with `tool_id` leading, a bare
 * `occurred_at < $1` range predicate (no `tool_id` filter) cannot be served
 * as an index range scan; PGlite plans it as a sequential scan of the whole
 * table. The scheduled-maintenance retention sweep
 * (`services/scheduled-database-maintenance.ts`) filters on `occurred_at`
 * alone on both its idle and active-queue paths, so it needs its own index.
 *
 * Version 84 is intentionally skipped here: it is claimed by the still-open
 * BST-1192 PR (#2333). This migration must not collide with it.
 */
export const migration085ToolCallTelemetryOccurredAtIndex: Migration = {
  down: `
    DROP INDEX IF EXISTS brainstrike_tool_call_telemetry_occurred_at_idx;
  `,
  ledgerKey: 'custom-085-tool-call-telemetry-occurred-at-index',
  name: 'tool_call_telemetry_occurred_at_index',
  up: `
    CREATE INDEX IF NOT EXISTS brainstrike_tool_call_telemetry_occurred_at_idx
      ON brainstrike_tool_call_telemetry (occurred_at);
  `,
  version: 85,
};
