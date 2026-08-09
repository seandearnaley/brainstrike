import type { Migration } from './migration-runner';

/** Allow provider-exact auxiliary compaction-summary usage rows (BST-1200 M2). */
export const migration089CompactionSummaryRunUsageKind: Migration = {
  down: `
    ALTER TABLE brainstrike_assistant_run_usage
      DROP CONSTRAINT IF EXISTS brainstrike_assistant_run_usage_run_kind_check;
    ALTER TABLE brainstrike_assistant_run_usage
      ADD CONSTRAINT brainstrike_assistant_run_usage_run_kind_check
      CHECK (run_kind IN ('chat', 'subagent', 'om-observation', 'om-reflection'));
  `,
  name: 'compaction_summary_run_usage_kind',
  up: `
    ALTER TABLE brainstrike_assistant_run_usage
      DROP CONSTRAINT IF EXISTS brainstrike_assistant_run_usage_run_kind_check;
    ALTER TABLE brainstrike_assistant_run_usage
      ADD CONSTRAINT brainstrike_assistant_run_usage_run_kind_check
      CHECK (run_kind IN ('chat', 'subagent', 'compaction-summary', 'om-observation', 'om-reflection'));
  `,
  version: 89,
};
