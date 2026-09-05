import type { Migration } from './migration-runner';

/**
 * Migration 079: `brainstrike_mind_ops` — the sync-the-mind op-log seam
 * (BST-993; ruling 2026-07-28: future sync covers threads/memory/prompts,
 * never vectors/HNSW).
 *
 * Append-only, Brainstrike-owned sidecar (never ALTER a mastra_* table —
 * thread-groups/thread-search precedent). Delete ops only for now: tombstone
 * semantics derive FROM this log, so Mastra-owned rows keep physically
 * disappearing (the thread-search orphan GC's anti-join and the readonly
 * sandbox role both depend on that). The CHECK constraints are deliberate:
 * widening the op or entity vocabulary is a conscious migration when a sync
 * engine is actually chosen, not a silent drift channel.
 *
 * `seq` (BIGSERIAL) is the lamport-ish local order; device identity is a
 * future engine's concern and is intentionally absent. `resource_id` is NOT:
 * threads are workspace-scoped and the scope is unrecoverable once the
 * thread row is physically gone, so every thread tombstone captures it at
 * delete time (from the same DELETE ... RETURNING). Nullable because
 * prompt items are global (review #2167).
 */
export const migration079MindOpsLog: Migration = {
  down: `
    DROP TABLE IF EXISTS brainstrike_mind_ops;
  `,
  ledgerKey: 'custom-079-mind-ops-log',
  name: 'mind_ops_log',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_mind_ops (
      seq BIGSERIAL PRIMARY KEY,
      entity_kind TEXT NOT NULL CHECK (entity_kind IN ('thread', 'prompt_item')),
      entity_id TEXT NOT NULL,
      op TEXT NOT NULL CHECK (op = 'delete'),
      resource_id TEXT,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS brainstrike_mind_ops_entity_idx
      ON brainstrike_mind_ops (entity_kind, entity_id);
  `,
  version: 79,
};
