import type { Migration } from './migration-runner';

/**
 * Durable assistant-ui branch topology for edited prompts and regenerated
 * responses. Mastra remains the content writer for `mastra_messages`; this
 * Brainstrike-owned companion table stores only message -> parent edges.
 *
 * `message_id` and `parent_id` intentionally have no message FK because the
 * client history adapter can record an edge before Mastra saves the matching
 * content row. There is also no thread FK because numbered DB migrations run
 * against a bare schema without Mastra tables; the app-shell thread-delete
 * transaction and factory reset explicitly own cleanup.
 */
export const migration055AssistantMessageParents: Migration = {
  down: 'DROP TABLE IF EXISTS brainstrike_assistant_message_parents;',
  ledgerKey: 'custom-055-assistant-message-parents',
  name: 'assistant_message_parents',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_assistant_message_parents (
      message_id text PRIMARY KEY,
      thread_id text NOT NULL,
      resource_id text NOT NULL,
      parent_id text,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_message_parents_thread_idx
      ON brainstrike_assistant_message_parents (thread_id, resource_id);
  `,
  version: 55,
};
