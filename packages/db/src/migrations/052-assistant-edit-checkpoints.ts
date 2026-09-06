import type { Migration } from './migration-runner';

/**
 * Durable per-turn edit checkpoint journal (undo of agent file edits).
 *
 * Every agent file mutation (`writeWorkspaceFile`, `stringReplaceWorkspaceFile`,
 * `deleteWorkspaceFile`, `renameWorkspaceFile`) records one undoable row here,
 * grouped by run/turn, so a per-tool-card "Revert" survives reload. Sister table
 * to `brainstrike_assistant_run_usage` (046) and `brainstrike_assistant_run_events`.
 *
 * The full BEFORE-content is stored (capped/binary-refused via `capture_status`),
 * not a diff, so a revert is an exact independent write and conflict detection is
 * a hash compare. `after_hash`/`after_existed` snapshot the post-mutation state
 * for conflict detection only (no after-content — redo is deferred v1).
 *
 * NO foreign keys (mirrors the run_usage 046 precedent): the numbered migration
 * runner (used by tests) and the drizzle path both run on a bare PGlite where the
 * parent `brainstrike_assistant_thread_runs` / `mastra_threads` tables are NOT
 * migration-created (they are bootstrapped by the app-shell repository / owned by
 * Mastra). An FK REFERENCES to a table absent in the migration path would fail the
 * full migration suite. Thread deletion therefore leaves orphan rows (rare;
 * factory reset purges the table). run_id/thread_id/resource_id are plain text.
 *
 * CREATE TABLE IF NOT EXISTS because the dual migration runner creates tables on
 * different paths; the desktop/renderer repository ALSO bootstraps this table on
 * first read, so the migration and the runtime bootstrap must stay byte-identical.
 */
export const migration052AssistantEditCheckpoints: Migration = {
  down: `
    DROP INDEX IF EXISTS brainstrike_assistant_edit_checkpoints_revert_idx;
    --> statement-breakpoint

    DROP INDEX IF EXISTS brainstrike_assistant_edit_checkpoints_run_idx;
    --> statement-breakpoint

    DROP INDEX IF EXISTS brainstrike_assistant_edit_checkpoints_thread_idx;
    --> statement-breakpoint

    DROP TABLE IF EXISTS brainstrike_assistant_edit_checkpoints;
  `,
  ledgerKey: 'custom-052-assistant-edit-checkpoints',
  name: 'assistant_edit_checkpoints',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_assistant_edit_checkpoints (
      id             text PRIMARY KEY,
      run_id         text NOT NULL,
      resource_id    text NOT NULL,
      thread_id      text NOT NULL,
      tool_call_id   text,
      tool_name      text NOT NULL,
      op             text NOT NULL CHECK (op IN ('write','string_replace','delete','rename')),
      root_id        text NOT NULL,
      path           text NOT NULL,
      from_path      text,
      before_existed boolean NOT NULL,
      before_hash    text,
      before_content text,
      before_size    integer,
      after_hash     text,
      after_existed  boolean NOT NULL,
      capture_status text NOT NULL CHECK (capture_status IN
                       ('ok','created','skipped_binary','skipped_too_large','expired','rename')),
      reverted_at    timestamptz,
      occurred_at    timestamptz NOT NULL,
      created_at     timestamptz NOT NULL,
      updated_at     timestamptz NOT NULL
    );
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_edit_checkpoints_thread_idx
      ON brainstrike_assistant_edit_checkpoints (thread_id, resource_id, occurred_at ASC, id ASC);
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_edit_checkpoints_run_idx
      ON brainstrike_assistant_edit_checkpoints (run_id, occurred_at ASC, id ASC);
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_edit_checkpoints_revert_idx
      ON brainstrike_assistant_edit_checkpoints (thread_id, reverted_at);
  `,
  version: 52,
};
