import type { Migration } from './migration-runner';

/**
 * Migration 089: record the resolved per-run tool-result budget tier alongside
 * estimator calibration samples (BST-1219).
 *
 * Historical rows stay NULL: they predate per-run producer threading and no
 * trustworthy tier can be reconstructed after the fact. New writers persist
 * the domain and transport token bounds resolved once by the agent runtime, so
 * the calibration lens can distinguish estimator drift from budget-tier mix.
 * Both columns are nullable for backward-compatible producers but, when
 * present, must be positive. `IF NOT EXISTS` / `IF EXISTS` keeps both directions
 * idempotent. Rollback removes only the added segmentation metadata and leaves
 * every migration-086 calibration pair intact.
 */
export const migration089TokenEstimateCalibrationResolvedBudgets: Migration = {
  down: `
    ALTER TABLE IF EXISTS brainstrike_token_estimate_calibration
      DROP COLUMN IF EXISTS resolved_domain_budget_tokens,
      DROP COLUMN IF EXISTS resolved_transport_budget_tokens;
  `,
  ledgerKey: 'custom-089-token-estimate-calibration-resolved-budgets',
  name: 'token_estimate_calibration_resolved_budgets',
  up: `
    ALTER TABLE brainstrike_token_estimate_calibration
      ADD COLUMN IF NOT EXISTS resolved_domain_budget_tokens integer
        CHECK (resolved_domain_budget_tokens IS NULL OR resolved_domain_budget_tokens > 0),
      ADD COLUMN IF NOT EXISTS resolved_transport_budget_tokens integer
        CHECK (resolved_transport_budget_tokens IS NULL OR resolved_transport_budget_tokens > 0);
  `,
  version: 89,
};
