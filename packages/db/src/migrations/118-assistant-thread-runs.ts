import type { Migration } from './migration-runner';

/**
 * The assistant run header and its run-event timeline (BST-1651).
 *
 * These two relations were the ONLY schema in the product created solely at
 * runtime, by `buildAssistantThreadRunsSchemaSql()` in
 * `packages/assistant-data`. The settled 2026-07-24 ruling that they "must not
 * get a numbered migration" rested on one premise: both carry `ON DELETE
 * CASCADE` foreign keys to parents no migration created — `mastra_threads`, and
 * the run row itself. Migration 117 now creates `mastra_threads`, so the premise
 * is gone and the FKs can be declared here exactly as the bootstrap declared
 * them. With this migration the repository creates nothing and instead PROBES,
 * which is what turns a schema mismatch from a silent, latent corruption into a
 * named, immediate error (`AssistantMemorySchemaMissingError`).
 *
 * ADDITIVE STATEMENTS ARE LOAD-BEARING, not defensive noise. An install that
 * predates BST-1163 has a `thread_runs` table without `turn_message_id`, and
 * `CREATE TABLE IF NOT EXISTS` will not add it — the `ALTER … ADD COLUMN IF NOT
 * EXISTS` is that install's only upgrade path now that the bootstrap no longer
 * re-runs it on every handle init. The same applies to the two partial approval
 * indexes and to dropping the pre-BST-1440 `…_approval_answer_idx`, whose shape
 * (trailing `run_id`) encoded the false premise that a call's pre-pause start
 * always shares its pause's run.
 *
 * The two partial indexes serve the threads-panel "needs you" anti-join
 * (BST-1404/BST-1440): every other index on `run_events` leads with `thread_id`
 * or `run_id`, so without them that resource-and-kind-scoped query full-scanned
 * the largest assistant table on BOTH sides, on every `run_events` notify.
 */
export const migration118AssistantThreadRuns: Migration = {
  down: `
    DROP TABLE IF EXISTS brainstrike_assistant_run_events;
    --> statement-breakpoint
    DROP TABLE IF EXISTS brainstrike_assistant_thread_runs;
  `,
  ledgerKey: 'custom-118-assistant-thread-runs',
  name: 'assistant_thread_runs',
  up: `
CREATE TABLE IF NOT EXISTS brainstrike_assistant_thread_runs (
  id text PRIMARY KEY,
  resource_id text NOT NULL,
  thread_id text NOT NULL REFERENCES mastra_threads(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  model_settings jsonb,
  provider_options jsonb,
  runtime_kind text NOT NULL,
  status text NOT NULL,
  error text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  turn_message_id text
);

ALTER TABLE brainstrike_assistant_thread_runs
  ADD COLUMN IF NOT EXISTS turn_message_id text;

CREATE INDEX IF NOT EXISTS brainstrike_assistant_thread_runs_resource_idx
  ON brainstrike_assistant_thread_runs (resource_id);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_thread_runs_thread_latest_idx
  ON brainstrike_assistant_thread_runs (resource_id, thread_id, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_thread_runs_status_idx
  ON brainstrike_assistant_thread_runs (status);

CREATE TABLE IF NOT EXISTS brainstrike_assistant_run_events (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES brainstrike_assistant_thread_runs(id) ON DELETE CASCADE,
  resource_id text NOT NULL,
  thread_id text NOT NULL REFERENCES mastra_threads(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  label text NOT NULL,
  detail text,
  duration_ms integer,
  metadata jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_events_thread_idx
  ON brainstrike_assistant_run_events (thread_id, resource_id, sequence ASC, occurred_at ASC);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_events_run_idx
  ON brainstrike_assistant_run_events (run_id, sequence ASC, occurred_at ASC);

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_events_approval_pause_idx
  ON brainstrike_assistant_run_events (resource_id, thread_id)
  WHERE kind = 'tool.approval.requested';

DROP INDEX IF EXISTS brainstrike_assistant_run_events_approval_answer_idx;

CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_events_approval_answer_at_idx
  ON brainstrike_assistant_run_events (resource_id, thread_id, (metadata->>'toolCallId'), occurred_at)
  WHERE kind IN ('tool.started', 'tool.completed', 'tool.failed', 'tool.resume.unsupported');
  `,
  version: 118,
};
