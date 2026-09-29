import type { Migration } from './migration-runner';

/**
 * Migration 092 (BST-1247): split substrate degradation out of `truncated`.
 *
 * `truncated` used to OR together output clipping with `scanLimited` /
 * `candidatesTruncated` from the search substrate. When ripgrep degraded to
 * the capped JS walk (BST-1246), every search recorded `truncated = true`
 * even with unclipped output — the 2026-08 audit read 94-100% "truncation"
 * as model misbehavior, and the `self-improvement-signal` lens's
 * `waste_score` told the model to change search behavior in response to
 * infrastructure failure.
 *
 * New columns, populated by the desktop telemetry writer from flags the
 * search results already carry:
 * - `engine`: live-pass engine for search tools ('ripgrep' | 'js-walk' |
 *   'skipped'); NULL for non-search tools AND for all pre-092 rows.
 * - `scan_limited`: the bounded scan/walk cap was hit.
 * - `candidates_truncated`: the candidate-set cap was hit.
 *
 * Historical rows are acknowledged-ambiguous: their `truncated` keeps the old
 * OR-folded meaning and is NOT backfilled with guesses (`engine IS NULL`
 * marks them). The 24h signal window ages them out quickly.
 */
export const migration092ToolCallTelemetrySubstrateSplit: Migration = {
  down: `
    ALTER TABLE brainstrike_tool_call_telemetry
      DROP COLUMN IF EXISTS engine,
      DROP COLUMN IF EXISTS scan_limited,
      DROP COLUMN IF EXISTS candidates_truncated;
  `,
  ledgerKey: 'custom-092-tool-call-telemetry-substrate-split',
  name: 'tool_call_telemetry_substrate_split',
  up: `
    ALTER TABLE brainstrike_tool_call_telemetry
      ADD COLUMN IF NOT EXISTS engine text,
      ADD COLUMN IF NOT EXISTS scan_limited boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS candidates_truncated boolean NOT NULL DEFAULT false;
  `,
  version: 92,
};
