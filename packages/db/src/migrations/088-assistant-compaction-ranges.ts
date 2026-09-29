import type { Migration } from './migration-runner';

/**
 * Migration 088: durable exact-message overlays for agentic conversation
 * compaction (BST-1200, Milestone 2).
 *
 * NO foreign keys: numbered migrations run without Mastra's lazy thread and
 * message tables. Thread deletion and factory reset own cleanup explicitly.
 * Raw Mastra message content remains unchanged; the exact ordered id set is
 * consulted only while building the next model input.
 */
export const migration088AssistantCompactionRanges: Migration = {
  down: 'DROP TABLE IF EXISTS brainstrike_assistant_compaction_ranges;',
  ledgerKey: 'custom-088-assistant-compaction-ranges',
  name: 'assistant_compaction_ranges',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_assistant_compaction_ranges (
      compaction_message_id text PRIMARY KEY,
      thread_id text NOT NULL,
      compacted_message_ids jsonb NOT NULL,
      kind text NOT NULL CHECK (kind IN ('agentic', 'deterministic')),
      created_at timestamptz NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_compaction_ranges_thread_idx
      ON brainstrike_assistant_compaction_ranges (thread_id);
  `,
  version: 88,
};
