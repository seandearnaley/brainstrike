import type { Migration } from './migration-runner.js';

/** Join existing root-attributed usage to its native invocation, without backfilling guesses. */
export const migration128DelegatedInvocationUsage: Migration = {
  down: `
    ALTER TABLE brainstrike_assistant_run_usage
      DROP CONSTRAINT IF EXISTS brainstrike_assistant_run_usage_delegation_fk,
      DROP CONSTRAINT IF EXISTS brainstrike_assistant_run_usage_delegation_check;
    DROP INDEX IF EXISTS brainstrike_assistant_run_usage_delegation_idx;
    ALTER TABLE brainstrike_assistant_run_usage
      DROP COLUMN IF EXISTS delegation_parent_run_id,
      DROP COLUMN IF EXISTS delegation_tool_call_id;
  `,
  ledgerKey: 'custom-128-delegated-invocation-usage',
  name: 'delegated_invocation_usage',
  up: `
    ALTER TABLE brainstrike_assistant_run_usage
      ADD COLUMN IF NOT EXISTS delegation_parent_run_id text,
      ADD COLUMN IF NOT EXISTS delegation_tool_call_id text;
    ALTER TABLE brainstrike_assistant_run_usage
      DROP CONSTRAINT IF EXISTS brainstrike_assistant_run_usage_delegation_fk,
      DROP CONSTRAINT IF EXISTS brainstrike_assistant_run_usage_delegation_check;
    ALTER TABLE brainstrike_assistant_run_usage
      ADD CONSTRAINT brainstrike_assistant_run_usage_delegation_check CHECK (
        (delegation_parent_run_id IS NULL AND delegation_tool_call_id IS NULL)
        OR (delegation_parent_run_id IS NOT NULL AND delegation_tool_call_id IS NOT NULL
          AND length(btrim(delegation_parent_run_id)) > 0
          AND length(btrim(delegation_tool_call_id)) > 0 AND run_kind = 'subagent')),
      ADD CONSTRAINT brainstrike_assistant_run_usage_delegation_fk
        FOREIGN KEY (thread_id, delegation_parent_run_id, delegation_tool_call_id)
        REFERENCES brainstrike_delegated_invocations
          (root_thread_id, parent_runtime_run_id, parent_tool_call_id) ON DELETE CASCADE;
    -- NULLS DISTINCT preserves historical and non-delegation usage rows.
    CREATE UNIQUE INDEX IF NOT EXISTS brainstrike_assistant_run_usage_delegation_idx
      ON brainstrike_assistant_run_usage (thread_id, delegation_parent_run_id, delegation_tool_call_id);
  `,
  version: 128,
};
