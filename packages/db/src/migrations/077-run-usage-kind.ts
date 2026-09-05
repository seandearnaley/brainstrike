import type { Migration } from './migration-runner';

/**
 * Run-usage attribution (BST-953): tag every run-usage row with the KIND of
 * model call that produced it, so the thread-total meter can break spend down
 * by source. 'chat' is the parent assistant turn (all pre-existing rows);
 * 'subagent' is a persona delegation child run (provider-exact usage);
 * 'om-observation' / 'om-reflection' are observational-memory background
 * cycles (locally-estimated token sizes — see assistant-persistence.md).
 * The CHECK constraint keeps unknown kinds a visible failure, never a
 * silently-mislabeled row.
 */
export const migration077RunUsageKind: Migration = {
  down: `
    ALTER TABLE IF EXISTS brainstrike_assistant_run_usage
      DROP COLUMN IF EXISTS run_kind;
  `,
  ledgerKey: 'custom-077-run-usage-kind',
  name: 'run_usage_kind',
  up: `
    ALTER TABLE brainstrike_assistant_run_usage
      ADD COLUMN IF NOT EXISTS run_kind text NOT NULL DEFAULT 'chat'
      CHECK (run_kind IN ('chat', 'subagent', 'om-observation', 'om-reflection'));
  `,
  version: 77,
};
