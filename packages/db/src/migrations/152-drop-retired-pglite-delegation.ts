import type { Migration } from './migration-runner.js';

/** BST-1987: the agent host owns delegation; no runtime writes these PGlite ledgers. */
export const migration152DropRetiredPgliteDelegation: Migration = {
  ledgerKey: 'custom-152-drop-retired-pglite-delegation',
  name: 'drop_retired_pglite_delegation',
  up: `
    ALTER TABLE brainstrike_assistant_run_usage
      DROP COLUMN IF EXISTS delegation_parent_run_id,
      DROP COLUMN IF EXISTS delegation_tool_call_id,
      DROP COLUMN IF EXISTS continuation_id;
    DROP TABLE IF EXISTS brainstrike_delegated_continuation_decisions;
    DROP TABLE IF EXISTS brainstrike_delegated_continuations;
    DROP TABLE IF EXISTS brainstrike_delegated_tool_decisions;
    DROP TABLE IF EXISTS brainstrike_delegated_invocations;
    DROP TABLE IF EXISTS brainstrike_delegated_conversations;
    DROP TABLE IF EXISTS brainstrike_delegated_live_decisions;
    DROP TABLE IF EXISTS brainstrike_delegated_wakeups;
    DROP TABLE IF EXISTS brainstrike_delegation_step_reservations;
    DROP TABLE IF EXISTS brainstrike_delegation_child_budgets;
    DROP TABLE IF EXISTS brainstrike_delegation_budgets;
  `,
  version: 152,
};
