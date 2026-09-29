import type { Migration } from './migration-runner.js';

/** Admission records only; native Mastra snapshots remain the execution authority. */
export const migration131DelegatedToolDecisions: Migration = {
  down: `DROP TABLE IF EXISTS brainstrike_delegated_tool_decisions;
    ALTER TABLE brainstrike_delegated_invocations DROP COLUMN IF EXISTS original_tool_call;`,
  ledgerKey: 'custom-131-delegated-tool-decisions',
  name: 'delegated_tool_decisions',
  up: `
    ALTER TABLE brainstrike_delegated_invocations ADD COLUMN IF NOT EXISTS original_tool_call jsonb;
    CREATE TABLE IF NOT EXISTS brainstrike_delegated_tool_decisions (
      id text PRIMARY KEY,
      owner_resource_id text NOT NULL,
      root_thread_id text NOT NULL,
      parent_runtime_run_id text NOT NULL,
      parent_tool_call_id text NOT NULL,
      child_thread_id text NOT NULL,
      child_runtime_run_id text NOT NULL,
      tool_call_id text NOT NULL CHECK (length(btrim(tool_call_id)) > 0),
      host_run_id text NOT NULL REFERENCES brainstrike_assistant_thread_runs(id) ON DELETE CASCADE,
      state text NOT NULL CHECK (state IN ('claimed', 'consumed', 'interrupted')),
      created_at timestamptz NOT NULL DEFAULT NOW(),
      finished_at timestamptz,
      UNIQUE (root_thread_id, child_runtime_run_id, tool_call_id),
      FOREIGN KEY (root_thread_id, parent_runtime_run_id, parent_tool_call_id)
        REFERENCES brainstrike_delegated_invocations(root_thread_id, parent_runtime_run_id, parent_tool_call_id)
        ON DELETE CASCADE,
      FOREIGN KEY (root_thread_id, child_thread_id, child_runtime_run_id)
        REFERENCES brainstrike_delegated_invocations(root_thread_id, thread_id, child_runtime_run_id)
        ON DELETE CASCADE,
      FOREIGN KEY (child_thread_id, root_thread_id, owner_resource_id)
        REFERENCES brainstrike_delegated_conversations(thread_id, root_thread_id, owner_resource_id)
        ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS brainstrike_delegated_tool_decisions_active_root_idx
      ON brainstrike_delegated_tool_decisions(root_thread_id) WHERE state = 'claimed';
  `,
  version: 131,
};
