import type { Migration } from './migration-runner';

/**
 * Migration 080: `brainstrike_assistant_message_tombstones` — the soft-rewind
 * tombstone sidecar (BST-1115, Conversation Rewind).
 *
 * Rewinding a conversation hides a contiguous suffix of a thread WITHOUT
 * destroying it: Mastra remains the sole writer of `mastra_messages` content,
 * and every Brainstrike-owned read path anti-joins this table instead
 * (migration 055 parents precedent — sidecar, never an ALTER of a Mastra-owned
 * table, and no FK because numbered migrations run against a bare schema with
 * no Mastra tables present).
 *
 * `message_id` is the PRIMARY KEY, not a surrogate id: a message is tombstoned
 * at most once, by exactly one batch. That is what makes redo an exact inverse
 * — redo deletes the newest `rewind_id` batch and the content rows, untouched
 * throughout, become visible again. A second rewind that re-covers an
 * already-tombstoned message must keep the ORIGINAL batch's row (insert with
 * ON CONFLICT DO NOTHING) so undoing the newer rewind cannot resurrect
 * messages the older one hid.
 *
 * The two batch columns are deliberately separate because rewind has a SCOPE
 * CHOICE (`conversation-only` vs `conversation-and-files`):
 *
 * - `rewind_id` (NOT NULL) is the tombstone batch identity and the thing redo
 *   targets. It exists in BOTH modes.
 * - `revert_id` (NULLABLE) links the paired edit-checkpoint journal file
 *   revert. It is NULL for a `conversation-only` rewind, which performs no
 *   file revert at all.
 *
 * Collapsing them into one column would force either a fabricated revert id
 * for conversation-only rewinds or a nullable redo key — and a nullable redo
 * key is how a batch gets lost.
 *
 * Rows are hard-deleted at finalization (the next user message in the thread),
 * which is when the tombstoned messages themselves are deleted through Mastra's
 * own `deleteMessages` storage API. NO `brainstrike_mind_ops` row is emitted
 * for either the tombstone or the finalizing delete: `mind_ops.entity_kind` is
 * CHECK-constrained to {thread, prompt_item} and widening that vocabulary is a
 * conscious migration reserved for when a sync engine is actually chosen
 * (BST-993) — not something a feature branch does in passing.
 */
export const migration080AssistantMessageTombstones: Migration = {
  down: 'DROP TABLE IF EXISTS brainstrike_assistant_message_tombstones;',
  ledgerKey: 'custom-080-assistant-message-tombstones',
  name: 'assistant_message_tombstones',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_assistant_message_tombstones (
      message_id text PRIMARY KEY,
      thread_id text NOT NULL,
      rewind_id text NOT NULL,
      revert_id text,
      tombstoned_at timestamptz NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_message_tombstones_thread_idx
      ON brainstrike_assistant_message_tombstones (thread_id);

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_message_tombstones_rewind_idx
      ON brainstrike_assistant_message_tombstones (rewind_id);
  `,
  version: 80,
};
