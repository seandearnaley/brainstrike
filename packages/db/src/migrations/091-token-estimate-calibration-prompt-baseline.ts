import type { Migration } from './migration-runner';

/**
 * Migration 091: record the prompt-composition baseline alongside estimator
 * calibration samples (BST-1232).
 *
 * Historical rows stay NULL: they predate durable prompt-baseline capture and
 * no trustworthy system-instruction/task-list/tool-definition total can be
 * reconstructed after the fact. New writers persist the same run's prompt
 * breakdown sum so the next turn's compaction trigger can account for prompt
 * content that is unavailable at the pre-request compaction seam. The column
 * is nullable for backward-compatible producers but, when present, must be
 * positive. `IF NOT EXISTS` / `IF EXISTS` keeps both directions idempotent.
 * Rollback removes only the added baseline evidence and leaves every
 * migration-086 calibration pair and migration-089 budget tier intact.
 */
export const migration091TokenEstimateCalibrationPromptBaseline: Migration = {
  down: `
    ALTER TABLE IF EXISTS brainstrike_token_estimate_calibration
      DROP COLUMN IF EXISTS prompt_baseline_tokens;
  `,
  ledgerKey: 'custom-091-token-estimate-calibration-prompt-baseline',
  name: 'token_estimate_calibration_prompt_baseline',
  up: `
    ALTER TABLE brainstrike_token_estimate_calibration
      ADD COLUMN IF NOT EXISTS prompt_baseline_tokens integer
        CHECK (prompt_baseline_tokens IS NULL OR prompt_baseline_tokens > 0);
  `,
  version: 91,
};
