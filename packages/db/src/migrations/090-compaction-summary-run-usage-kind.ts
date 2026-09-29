import type { Migration } from './migration-runner';

/**
 * Allow provider-exact auxiliary compaction-summary usage rows (BST-1200 M2).
 *
 * Unlike migration 087's new named constraint, this migration must replace
 * migration 077's existing same-name CHECK to widen it. A catalog-guarded
 * ADD-only block would see the old constraint and leave compaction-summary
 * rejected. These numbered migration statements run in desktop main, never
 * through the renderer SQL guard; only the renderer bootstrap mirror must be
 * non-destructive.
 */
export const migration090CompactionSummaryRunUsageKind: Migration = {
  down: `
    ALTER TABLE brainstrike_assistant_run_usage
      DROP CONSTRAINT IF EXISTS brainstrike_assistant_run_usage_run_kind_check;
    ALTER TABLE brainstrike_assistant_run_usage
      ADD CONSTRAINT brainstrike_assistant_run_usage_run_kind_check
      CHECK (run_kind IN ('chat', 'subagent', 'om-observation', 'om-reflection'));
  `,
  ledgerKey: 'custom-090-compaction-summary-run-usage-kind',
  name: 'compaction_summary_run_usage_kind',
  up: `
    ALTER TABLE brainstrike_assistant_run_usage
      DROP CONSTRAINT IF EXISTS brainstrike_assistant_run_usage_run_kind_check;
    ALTER TABLE brainstrike_assistant_run_usage
      ADD CONSTRAINT brainstrike_assistant_run_usage_run_kind_check
      CHECK (run_kind IN ('chat', 'subagent', 'compaction-summary', 'om-observation', 'om-reflection'));
  `,
  version: 90,
};
