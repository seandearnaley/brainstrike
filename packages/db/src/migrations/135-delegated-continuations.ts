import type { Migration } from './migration-runner.js';

/** Human wake admissions are not native delegation tool invocations. */
export const migration135DelegatedContinuations: Migration = {
  down: `ALTER TABLE brainstrike_assistant_run_usage DROP COLUMN IF EXISTS continuation_id;
    DROP TABLE IF EXISTS brainstrike_delegated_continuation_decisions;
    DROP TABLE IF EXISTS brainstrike_delegated_continuations;`,
  ledgerKey: 'custom-135-delegated-continuations',
  name: 'delegated_continuations',
  up: `CREATE TABLE IF NOT EXISTS brainstrike_delegated_continuations (
    id text PRIMARY KEY CHECK (length(btrim(id)) > 0),
    owner_resource_id text NOT NULL,
    root_thread_id text NOT NULL,
    thread_id text NOT NULL,
    host_run_id text NOT NULL REFERENCES brainstrike_assistant_thread_runs(id) ON DELETE CASCADE,
    active_host_run_id text NOT NULL REFERENCES brainstrike_assistant_thread_runs(id) ON DELETE CASCADE,
    turn_message_id text NOT NULL CHECK (length(btrim(turn_message_id)) > 0),
    input_text text NOT NULL CHECK (length(btrim(input_text)) > 0),
    native_run_id text CHECK (length(btrim(native_run_id)) > 0),
    state text NOT NULL CHECK (state IN ('claimed', 'running', 'awaiting-approval', 'awaiting-input', 'completed', 'failed', 'cancelled', 'interrupted')),
    error text,
    cancellation_requested_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    UNIQUE(root_thread_id, thread_id, native_run_id),
    FOREIGN KEY(thread_id, root_thread_id, owner_resource_id)
      REFERENCES brainstrike_delegated_conversations(thread_id, root_thread_id, owner_resource_id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS brainstrike_delegated_continuations_active_root_idx
    ON brainstrike_delegated_continuations(root_thread_id)
    WHERE state IN ('claimed', 'running', 'awaiting-approval', 'awaiting-input');
  CREATE TABLE IF NOT EXISTS brainstrike_delegated_continuation_decisions (
    continuation_id text NOT NULL REFERENCES brainstrike_delegated_continuations(id) ON DELETE CASCADE,
    native_run_id text NOT NULL,
    target_runtime_run_id text NOT NULL CHECK (length(btrim(target_runtime_run_id)) > 0),
    tool_call_id text NOT NULL CHECK (length(btrim(tool_call_id)) > 0),
    kind text NOT NULL CHECK (kind IN ('tool-approval', 'tool-resume')),
    host_run_id text NOT NULL REFERENCES brainstrike_assistant_thread_runs(id) ON DELETE CASCADE,
    previous_host_run_id text NOT NULL REFERENCES brainstrike_assistant_thread_runs(id) ON DELETE CASCADE,
    state text NOT NULL CHECK (state IN ('claimed', 'consumed', 'interrupted')),
    created_at timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY(continuation_id, target_runtime_run_id, tool_call_id)
  );
  ALTER TABLE brainstrike_assistant_run_usage ADD COLUMN IF NOT EXISTS continuation_id text
    REFERENCES brainstrike_delegated_continuations(id) ON DELETE SET NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS brainstrike_assistant_run_usage_continuation_idx
    ON brainstrike_assistant_run_usage(continuation_id, run_id);`,
  version: 135,
};
