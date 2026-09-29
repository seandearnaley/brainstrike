import type { Migration } from './migration-runner.js';

/** Counters survive host recreation and child deletion; deleting the root clears them. */
export const migration132DelegationBudgets: Migration = {
  down: 'DROP TABLE IF EXISTS brainstrike_delegation_step_reservations; DROP TABLE IF EXISTS brainstrike_delegation_child_budgets; DROP TABLE IF EXISTS brainstrike_delegation_budgets;',
  ledgerKey: 'custom-132-delegation-budgets',
  name: 'delegation_budgets',
  up: `CREATE TABLE IF NOT EXISTS brainstrike_delegation_budgets (
    root_thread_id text NOT NULL REFERENCES mastra_threads(id) ON DELETE CASCADE,
    turn_message_id text NOT NULL CHECK (length(btrim(turn_message_id)) > 0),
    owner_resource_id text NOT NULL,
    max_depth integer NOT NULL CHECK (max_depth > 0),
    max_invocations integer NOT NULL CHECK (max_invocations > 0),
    max_output_tokens integer NOT NULL CHECK (max_output_tokens > 0),
    charged_output_tokens integer NOT NULL DEFAULT 0 CHECK (charged_output_tokens >= 0),
    max_child_steps integer NOT NULL CHECK (max_child_steps > 0),
    max_child_output_tokens integer NOT NULL CHECK (max_child_output_tokens > 0),
    max_step_output_tokens integer NOT NULL CHECK (max_step_output_tokens > 0),
    synthesis_output_tokens integer NOT NULL CHECK (synthesis_output_tokens > 0),
    invocations integer NOT NULL DEFAULT 0 CHECK (invocations >= 0 AND invocations <= max_invocations),
    PRIMARY KEY (root_thread_id, turn_message_id)
  );
  CREATE TABLE IF NOT EXISTS brainstrike_delegation_child_budgets (
    root_thread_id text NOT NULL,
    turn_message_id text NOT NULL,
    child_thread_id text NOT NULL REFERENCES mastra_threads(id) ON DELETE CASCADE,
    max_steps integer NOT NULL CHECK (max_steps > 0),
    steps integer NOT NULL DEFAULT 0 CHECK (steps >= 0 AND steps <= max_steps),
    charged_output_tokens integer NOT NULL DEFAULT 0 CHECK (charged_output_tokens >= 0),
    synthesis_used boolean NOT NULL DEFAULT FALSE,
    PRIMARY KEY (root_thread_id, turn_message_id, child_thread_id),
    FOREIGN KEY (root_thread_id, turn_message_id)
      REFERENCES brainstrike_delegation_budgets(root_thread_id, turn_message_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS brainstrike_delegation_step_reservations (
    id text PRIMARY KEY,
    root_thread_id text NOT NULL,
    turn_message_id text NOT NULL,
    child_thread_id text NOT NULL,
    host_run_id text NOT NULL REFERENCES brainstrike_assistant_thread_runs(id) ON DELETE CASCADE,
    output_tokens integer NOT NULL CHECK (output_tokens > 0),
    settled boolean NOT NULL DEFAULT FALSE,
    FOREIGN KEY (root_thread_id, turn_message_id, child_thread_id)
      REFERENCES brainstrike_delegation_child_budgets(root_thread_id, turn_message_id, child_thread_id) ON DELETE CASCADE
  );`,
  version: 132,
};
