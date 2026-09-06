import type { Migration } from './migration-runner';

/**
 * Migration 095 (BST-1268, per-thread saved workspaces): one snapshot row per
 * assistant thread holding the thread's workspace state — open file/app tabs,
 * per-root tree expansions, root focus/visibility VIEWS, per-file pane and
 * editor state — as a versioned JSONB payload (`WorkspaceSnapshotV1`,
 * validated by `coerceWorkspaceSnapshot` at every read boundary; the DB never
 * interprets it).
 *
 * Modeled on migration 054's thread placements: Brainstrike-owned
 * presentation state keyed by `thread_id`, deliberately NOT in
 * `mastra_threads.metadata` (Mastra owns that schema) and with NO foreign key
 * to `mastra_threads` — the numbered runner runs on a bare PGlite without the
 * Mastra parents, and a workspace row whose thread no longer exists is inert.
 * Thread deletion cascades via `THREAD_DELETE_SIDECAR_TABLES`
 * (assistant-contract), which every delete implementation derives its stages
 * from. Sync roadmap (BST-911): thread-attached "mind" state; the existing
 * `entity_kind='thread'` tombstone covers deletion, so no op-vocabulary
 * change is laid here.
 *
 * The same DDL is mirrored ADD-ONLY in the assistant-data renderer bootstrap
 * (`buildAssistantThreadRunsSchemaSql`) — keep the shapes byte-identical.
 */
export const migration095AssistantThreadWorkspaces: Migration = {
  down: 'DROP TABLE IF EXISTS brainstrike_assistant_thread_workspaces;',
  ledgerKey: 'custom-095-assistant-thread-workspaces',
  name: 'assistant_thread_workspaces',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_assistant_thread_workspaces (
      thread_id text PRIMARY KEY,
      resource_id text NOT NULL,
      payload jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );
  `,
  version: 95,
};
