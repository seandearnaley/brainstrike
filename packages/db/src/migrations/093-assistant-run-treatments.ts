import type { Migration } from './migration-runner';

/**
 * Migration 093 (BST-1250, recursive self-improvement phase 2A): per-run
 * experiment treatment records.
 *
 * One row per hosted run, written by desktop main at prompt assembly — the
 * ONE seam that knows whether self-improvement signal injection (BST-1241)
 * actually happened for the run and the exact injected text
 * (signal_content_hash = SHA-256). Without this record, treatment could only
 * be inferred from date windows or the CURRENT preference value — both
 * unsound; the 2026-08 audit's evaluation gap (17 runs, 1 outcome label, no
 * attribution) is what this closes alongside hook-sourced verdicts.
 *
 * experiment_id/variant stay NULL for un-enrolled runs; preference-off runs
 * still get a row (signal_injected = false) — they are the control evidence.
 *
 * NO foreign keys (the numbered runner has no renderer-lazy
 * brainstrike_assistant_thread_runs parent), mirroring migration 062's
 * run_outcomes. The same DDL is mirrored in the assistant-data bootstrap
 * (assistant-memory-repository.ts) — keep the shapes byte-identical.
 * Treatment evidence survives thread deletion like run_outcomes and is
 * cleared on factory reset via the db reset registry.
 */
export const migration093AssistantRunTreatments: Migration = {
  down: 'DROP TABLE IF EXISTS brainstrike_assistant_run_treatments;',
  name: 'assistant_run_treatments',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_assistant_run_treatments (
      run_id text PRIMARY KEY,
      thread_id text NOT NULL,
      resource_id text NOT NULL,
      experiment_id text,
      variant text,
      signal_injected boolean NOT NULL,
      signal_content_hash text,
      created_at timestamptz NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_treatments_thread_idx
      ON brainstrike_assistant_run_treatments (thread_id, resource_id);

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_treatments_experiment_idx
      ON brainstrike_assistant_run_treatments (experiment_id, variant);
  `,
  version: 93,
};
