import type { Migration } from './migration-runner';

/**
 * Durable per-thread token usage (Phase 5.1).
 *
 * Brainstrike-owned sister table to `brainstrike_assistant_thread_runs`: every
 * provider-reported usage event is recorded as one row so cumulative token
 * counts and cost survive reload (the in-memory zustand store only holds the
 * last turn). model/provider are stored PER ROW — threads switch models
 * mid-conversation, so cost must be computed per row against that row's pricing
 * and summed, never against the thread's current model.
 *
 * CREATE TABLE IF NOT EXISTS because the dual migration runner (numbered runner
 * for tests, drizzle customMigrations for the real app) creates tables on
 * different paths; the desktop repository ALSO bootstraps this table on first
 * write, so the migration and the runtime bootstrap must agree.
 */
export const migration046AssistantRunUsage: Migration = {
  version: 46,
  name: 'assistant_run_usage',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_assistant_run_usage (
      id text PRIMARY KEY,
      thread_id text NOT NULL,
      run_id text NOT NULL,
      resource_id text NOT NULL,
      model text NOT NULL,
      provider text NOT NULL,
      input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
      output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
      created_at timestamptz NOT NULL DEFAULT NOW()
    );
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_usage_thread_idx
      ON brainstrike_assistant_run_usage (thread_id);
  `,
  down: `
    DROP INDEX IF EXISTS brainstrike_assistant_run_usage_thread_idx;
    --> statement-breakpoint

    DROP TABLE IF EXISTS brainstrike_assistant_run_usage;
  `,
};
