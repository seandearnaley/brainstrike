import type { Migration } from './migration-runner';

/**
 * User-defined thread groups (folders) for the assistant Threads panel.
 *
 * Brainstrike-owned sister tables to `brainstrike_assistant_task_lists` (050).
 * Group membership and manual ordering deliberately do NOT live in
 * `mastra_threads.metadata`: grouping and ordering are Brainstrike-owned
 * presentation state while the Mastra tables stay Mastra-owned. Placements have no FK to
 * `mastra_threads` for the same ownership reason — a placement whose thread is
 * gone is inert (the panel joins by id) and bulk thread deletion clears it in
 * the same guarded statement. `rank` columns are fractional-index keys (`fractional-indexing`
 * `generateKeyBetween`), so a reorder writes exactly one row. A placement with
 * `group_id IS NULL` is an ungrouped thread that has been manually ranked.
 *
 * CREATE TABLE IF NOT EXISTS because the dual migration runner (numbered runner
 * for tests, drizzle customMigrations for the real app) creates tables on
 * different paths.
 */
export const migration054AssistantThreadGroups: Migration = {
  down: `
    DROP TABLE IF EXISTS brainstrike_assistant_thread_placements;
    DROP TABLE IF EXISTS brainstrike_assistant_thread_groups;
  `,
  name: 'assistant_thread_groups',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_assistant_thread_groups (
      id          text PRIMARY KEY,
      resource_id text NOT NULL,
      name        text NOT NULL,
      rank        text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT NOW(),
      updated_at  timestamptz NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_thread_groups_resource_rank
      ON brainstrike_assistant_thread_groups (resource_id, rank);

    CREATE TABLE IF NOT EXISTS brainstrike_assistant_thread_placements (
      thread_id   text PRIMARY KEY,
      resource_id text NOT NULL,
      group_id    text,
      rank        text NOT NULL,
      updated_at  timestamptz NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_assistant_thread_placements_resource_group
      ON brainstrike_assistant_thread_placements (resource_id, group_id);
  `,
  version: 54,
};
