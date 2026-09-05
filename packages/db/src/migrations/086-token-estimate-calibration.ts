import type { Migration } from './migration-runner';

/**
 * Migration 086: durable estimator-vs-provider prompt-token calibration pairs.
 *
 * NO foreign keys: numbered migrations run without the renderer-lazy assistant
 * run/thread parents. Desktop derives thread ownership from the run row when it
 * inserts; thread deletion and factory reset own cleanup explicitly.
 *
 * Comparable final-prompt basis: `estimated_prompt_tokens` is the chars/4
 * backstop over model-visible tool-output projections plus tool definitions,
 * each counted once. `final_step_prompt_tokens` is the single most recent
 * step's prompt count, which already contains every prior tool output once via
 * Mastra's resend behavior—not the cross-step accumulated billing total.
 * Conversation/system-prompt text outside tool outputs and definitions is
 * excluded from both. Only completed runs with at least one measured tool
 * output persist a row.
 *
 * `id` uses `crypto.randomUUID()` at the writer, matching the sibling telemetry
 * ledger. Rows contain numbers, model/provider strings, ids, and timestamps
 * only — never message/tool content or file paths. Scheduled database
 * maintenance prunes rows after 60 days; the occurred_at-leading index is
 * created here from the start so both retention paths use an index range scan.
 */
export const migration086TokenEstimateCalibration: Migration = {
  down: 'DROP TABLE IF EXISTS brainstrike_token_estimate_calibration;',
  ledgerKey: 'custom-086-token-estimate-calibration',
  name: 'token_estimate_calibration',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_token_estimate_calibration (
      id text PRIMARY KEY,
      thread_id text NOT NULL,
      run_id text NOT NULL,
      model text NOT NULL,
      provider text NOT NULL,
      estimated_prompt_tokens integer NOT NULL CHECK (estimated_prompt_tokens >= 0),
      final_step_prompt_tokens integer NOT NULL CHECK (final_step_prompt_tokens >= 0),
      step_count integer NOT NULL DEFAULT 1 CHECK (step_count >= 1),
      model_visible_projection_count integer NOT NULL DEFAULT 0 CHECK (model_visible_projection_count >= 0),
      occurred_at timestamptz NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS brainstrike_token_estimate_calibration_thread_idx
      ON brainstrike_token_estimate_calibration (thread_id);

    CREATE INDEX IF NOT EXISTS brainstrike_token_estimate_calibration_model_idx
      ON brainstrike_token_estimate_calibration (model, occurred_at DESC);

    CREATE INDEX IF NOT EXISTS brainstrike_token_estimate_calibration_occurred_at_idx
      ON brainstrike_token_estimate_calibration (occurred_at);
  `,
  version: 86,
};
