import type { Migration } from './migration-runner';

/**
 * Flight Recorder P3: one immutable terminal provider-forensics row per
 * renderer-minted assistant run.
 *
 * No foreign key is possible here: the numbered migration runner executes on
 * a bare database, while brainstrike_assistant_thread_runs is renderer-lazy.
 * The repository compensates by deriving thread/resource ownership from the
 * parent and throwing when that parent is absent. Thread deletion and every
 * table-enumerating reset path delete this FK-less relation explicitly.
 *
 * `attempts` is intentionally absent. The current Mastra retry processors
 * expose neither a complete attempt stream nor the actual waited duration, so
 * persisting an attempts array would fabricate incomplete retry history.
 */
export const migration076AssistantRunErrors: Migration = {
  down: `
    DROP INDEX IF EXISTS bst_diagnostic_events_run_idx;
    --> statement-breakpoint
    DROP INDEX IF EXISTS bst_assistant_run_errors_resource_idx;
    --> statement-breakpoint
    DROP INDEX IF EXISTS bst_assistant_run_errors_thread_idx;
    --> statement-breakpoint
    DROP TABLE IF EXISTS brainstrike_assistant_run_errors;
  `,
  ledgerKey: 'custom-076-assistant-run-errors',
  name: 'assistant_run_errors',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_assistant_run_errors (
      run_id              TEXT PRIMARY KEY,
      thread_id           TEXT NOT NULL,
      resource_id         TEXT NOT NULL,
      code                TEXT NOT NULL,
      message             TEXT,
      cause_chain         JSONB,
      http_status         INTEGER,
      provider_request_id TEXT,
      response_headers    JSONB,
      occurred_at         TIMESTAMPTZ NOT NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT bst_assistant_run_errors_run_check
        CHECK (length(run_id) > 0),
      CONSTRAINT bst_assistant_run_errors_thread_check
        CHECK (length(thread_id) > 0),
      CONSTRAINT bst_assistant_run_errors_resource_check
        CHECK (length(resource_id) > 0),
      CONSTRAINT bst_assistant_run_errors_code_check
        CHECK (length(code) > 0),
      CONSTRAINT bst_assistant_run_errors_cause_chain_check
        CHECK (cause_chain IS NULL OR jsonb_typeof(cause_chain) = 'array'),
      CONSTRAINT bst_assistant_run_errors_http_status_check
        CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
      CONSTRAINT bst_assistant_run_errors_response_headers_check
        CHECK (response_headers IS NULL OR jsonb_typeof(response_headers) = 'object')
    );
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS bst_assistant_run_errors_thread_idx
      ON brainstrike_assistant_run_errors (thread_id, occurred_at DESC);
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS bst_assistant_run_errors_resource_idx
      ON brainstrike_assistant_run_errors (resource_id, occurred_at DESC);
    --> statement-breakpoint

    CREATE INDEX IF NOT EXISTS bst_diagnostic_events_run_idx
      ON brainstrike_diagnostic_events (run_id, occurred_at DESC)
      WHERE run_id IS NOT NULL;
  `,
  version: 76,
};
