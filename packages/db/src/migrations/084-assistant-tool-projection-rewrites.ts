import type { Migration } from './migration-runner';

/**
 * Migration 084: transient-replay overlays for superseded workspace reads.
 *
 * NO foreign keys: numbered migrations run without Mastra's lazy thread and
 * message tables. Thread deletion and factory reset own cleanup explicitly.
 * Durable Mastra message content is never mutated; this sidecar is consulted
 * only while building the next model prompt.
 */
export const migration084AssistantToolProjectionRewrites: Migration = {
  down: 'DROP TABLE IF EXISTS brainstrike_assistant_tool_projection_rewrites;',
  ledgerKey: 'custom-084-assistant-tool-projection-rewrites',
  name: 'assistant_tool_projection_rewrites',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_assistant_tool_projection_rewrites (
      tool_call_id text PRIMARY KEY,
      thread_id text NOT NULL,
      rewrite_id text NOT NULL,
      superseded_by_tool_call_id text NOT NULL,
      marker_text text NOT NULL,
      original_chars integer NOT NULL CHECK (original_chars >= 0),
      created_at timestamptz NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_tool_projection_rewrites_thread_idx
      ON brainstrike_assistant_tool_projection_rewrites (thread_id);
  `,
  version: 84,
};
