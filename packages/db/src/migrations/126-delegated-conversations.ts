import type { Migration } from './migration-runner.js';

/** Brainstrike owns ancestry; Mastra continues to own conversation content. */
export const migration126DelegatedConversations: Migration = {
  down: 'DROP TABLE IF EXISTS brainstrike_delegated_conversations;',
  ledgerKey: 'custom-126-delegated-conversations',
  name: 'delegated_conversations',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_delegated_conversations (
      thread_id text PRIMARY KEY REFERENCES mastra_threads(id) ON DELETE CASCADE,
      owner_resource_id text NOT NULL CHECK (length(owner_resource_id) > 0),
      root_thread_id text NOT NULL REFERENCES brainstrike_delegated_conversations(thread_id) ON DELETE CASCADE,
      parent_thread_id text,
      resource_id text NOT NULL CHECK (length(resource_id) > 0),
      workspace_root_id text CHECK (workspace_root_id IS NULL OR length(btrim(workspace_root_id)) > 0),
      configuration jsonb,
      display_name text,
      color text CHECK (color IN ('blue', 'emerald', 'amber', 'rose', 'violet', 'slate')),
      created_at timestamptz NOT NULL DEFAULT NOW(),
      UNIQUE (thread_id, root_thread_id, owner_resource_id),
      FOREIGN KEY (parent_thread_id, root_thread_id, owner_resource_id)
        REFERENCES brainstrike_delegated_conversations(thread_id, root_thread_id, owner_resource_id)
        ON DELETE CASCADE,
      CHECK (
        (thread_id = root_thread_id AND parent_thread_id IS NULL
          AND resource_id = owner_resource_id AND configuration IS NULL
          AND display_name IS NULL AND color IS NULL AND workspace_root_id IS NULL)
        OR
        (thread_id <> root_thread_id AND parent_thread_id IS NOT NULL
          AND parent_thread_id <> thread_id AND configuration IS NOT NULL
          AND jsonb_typeof(configuration) = 'object'
          AND display_name IS NOT NULL AND length(btrim(display_name)) > 0
          AND color IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS brainstrike_delegated_conversations_parent_idx
      ON brainstrike_delegated_conversations (root_thread_id, owner_resource_id, parent_thread_id, created_at, thread_id);
  `,
  version: 126,
};
