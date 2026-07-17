import type { Migration } from './migration-runner';

/**
 * Durable per-thread assistant task list (P0 task-list tool).
 *
 * Brainstrike-owned sister table to `brainstrike_assistant_run_usage` (046).
 * One row per thread holds the assistant's current plan as a JSON task array;
 * `manageTaskList` whole-replaces it (`INSERT ... ON CONFLICT (thread_id) DO
 * UPDATE`). The server reads it at request start and re-serializes it into the
 * system instructions every turn so the plan survives observational-memory
 * truncation. `resource_id` is stored for attribution but the thread is the key
 * (one plan per thread — v1).
 *
 * CREATE TABLE IF NOT EXISTS because the dual migration runner (numbered runner
 * for tests, drizzle customMigrations for the real app) creates tables on
 * different paths.
 */
export const migration050AssistantTaskLists: Migration = {
  down: `
    DROP TABLE IF EXISTS brainstrike_assistant_task_lists;
  `,
  name: 'assistant_task_lists',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_assistant_task_lists (
      thread_id   text PRIMARY KEY,
      resource_id text NOT NULL,
      tasks       jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_at  timestamptz NOT NULL DEFAULT NOW()
    );
  `,
  version: 50,
};
