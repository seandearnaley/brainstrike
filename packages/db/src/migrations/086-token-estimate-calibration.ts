import type { Migration } from './migration-runner';

/**
 * Migration 086: durable estimator-vs-provider prompt-token calibration pairs.
 *
 * NO foreign keys: numbered migrations run without the renderer-lazy assistant
 * run/thread parents. Desktop derives thread ownership from the run row when it
 * inserts; thread deletion and factory reset own cleanup explicitly.
 *
 * `estimated_prompt_tokens` is deliberately partial. It is the chars/4
 * backstop over RunTokenDiagnostics' model-visible tool-output projections plus
 * tool definitions only; it excludes full conversation and system-prompt text.
 * The paired provider figure is therefore a reconciliation signal for that
 * share, not a full budget-meter calibration factor.
 *
 * `id` uses `crypto.randomUUID()` at the writer, matching the sibling telemetry
 * ledger. Rows contain numbers, model/provider strings, ids, and timestamps
 * only — never message/tool content or file paths. Scheduled database
 * maintenance prunes rows after 60 days; the occurred_at-leading index is
 * created here from the start so both retention paths use an index range scan.
 */
export const migration086TokenEstimateCalibration: Migration = {
  down: 'DROP TABLE IF EXISTS brainstrike_token_estimate_calibration;',
  name: 'token_estimate_calibration',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_token_estimate_calibration (
      id text PRIMARY KEY,
      thread_id text NOT NULL,
      run_id text NOT NULL,
      model text NOT NULL,
      provider text NOT NULL,
      estimated_prompt_tokens integer NOT NULL CHECK (estimated_prompt_tokens >= 0),
      provider_reported_prompt_tokens integer NOT NULL CHECK (provider_reported_prompt_tokens >= 0),
      occurred_at timestamptz NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS brainstrike_token_estimate_calibration_model_idx
      ON brainstrike_token_estimate_calibration (model, occurred_at DESC);

    CREATE INDEX IF NOT EXISTS brainstrike_token_estimate_calibration_occurred_at_idx
      ON brainstrike_token_estimate_calibration (occurred_at);
  `,
  version: 86,
};
