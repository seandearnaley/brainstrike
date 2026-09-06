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
 * experiment_id/variant stay NULL for un-enrolled runs. injection_status
 * keeps the non-injection reasons apart (review): 'preference_off' is
 * control evidence, 'query_failed' is an enrolled arm whose signal was
 * unavailable, 'no_waste' is an empty hour, and 'continuation' marks
 * approval/resume legs that never reach prompt assembly. signal_injected is
 * derived (status = 'injected') and CHECK-pinned to stay consistent. The
 * only shipped reader (the experiment-outcome-correlation lens) filters on
 * created_at alone, so that is the ONLY index (review: the run_outcomes-
 * style thread/experiment indexes served no reader and left the lens a
 * seq scan that outgrows the sandbox's EXPLAIN cost ceiling).
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
  ledgerKey: 'custom-093-assistant-run-treatments',
  name: 'assistant_run_treatments',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_assistant_run_treatments (
      run_id text PRIMARY KEY,
      thread_id text NOT NULL,
      resource_id text NOT NULL,
      experiment_id text,
      variant text,
      injection_status text NOT NULL CHECK (
        injection_status IN ('continuation', 'injected', 'no_waste', 'preference_malformed', 'preference_off', 'query_failed')
      ),
      signal_injected boolean NOT NULL,
      signal_content_hash text,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      CONSTRAINT brainstrike_assistant_run_treatments_injected_consistency
        CHECK (signal_injected = (injection_status = 'injected'))
    );

    CREATE INDEX IF NOT EXISTS brainstrike_assistant_run_treatments_created_at_idx
      ON brainstrike_assistant_run_treatments (created_at);
  `,
  version: 93,
};
