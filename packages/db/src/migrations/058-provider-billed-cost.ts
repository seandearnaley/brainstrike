import type { Migration } from './migration-runner';

/** Persist exact provider-reported billed cost alongside token usage. */
export const migration058ProviderBilledCost: Migration = {
  down: `
    ALTER TABLE IF EXISTS brainstrike_assistant_run_usage
      DROP COLUMN IF EXISTS billed_cost_usd;
  `,
  name: 'provider_billed_cost',
  up: `
    ALTER TABLE brainstrike_assistant_run_usage
      ADD COLUMN IF NOT EXISTS billed_cost_usd numeric(24, 12)
      CHECK (billed_cost_usd >= 0);
  `,
  version: 58,
};
