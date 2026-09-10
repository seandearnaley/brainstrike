import type { Migration } from './migration-runner.js';

/** Native run identity is distinct from the root host's persisted execution leg. */
export const migration127DelegatedInvocations: Migration = {
  down: 'DROP TABLE IF EXISTS brainstrike_delegated_invocations;',
  ledgerKey: 'custom-127-delegated-invocations',
  name: 'delegated_invocations',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_delegated_invocations (
      owner_resource_id text NOT NULL,
      root_thread_id text NOT NULL,
      thread_id text NOT NULL,
      host_run_id text NOT NULL REFERENCES brainstrike_assistant_thread_runs(id) ON DELETE CASCADE,
      turn_message_id text NOT NULL CHECK (length(btrim(turn_message_id)) > 0),
      parent_runtime_run_id text NOT NULL CHECK (length(btrim(parent_runtime_run_id)) > 0),
      parent_tool_call_id text NOT NULL CHECK (length(btrim(parent_tool_call_id)) > 0),
      persona_id text NOT NULL CHECK (length(btrim(persona_id)) > 0),
      child_runtime_run_id text CHECK (length(btrim(child_runtime_run_id)) > 0
        AND child_runtime_run_id <> parent_runtime_run_id),
      created_at timestamptz NOT NULL DEFAULT NOW(),
      PRIMARY KEY (root_thread_id, parent_runtime_run_id, parent_tool_call_id),
      -- NULLS DISTINCT deliberately permits multiple not-yet-started follow-ups.
      UNIQUE (root_thread_id, thread_id, child_runtime_run_id),
      FOREIGN KEY (thread_id, root_thread_id, owner_resource_id)
        REFERENCES brainstrike_delegated_conversations(thread_id, root_thread_id, owner_resource_id)
        ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS brainstrike_delegated_invocations_host_run_idx
      ON brainstrike_delegated_invocations (host_run_id);
  `,
  version: 127,
};
