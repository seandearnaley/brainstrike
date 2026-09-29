import type { Migration } from './migration-runner';

/**
 * Anthropic prompt-cache token accounting (BST-587): persist cache-read and
 * cache-write input token counts per run-usage row. `input_tokens` remains the
 * TOTAL the model saw (it already includes both cache classes), so existing
 * rows and aggregations stay valid — old rows simply have NULL cache counts.
 */
export const migration069RunUsageCacheTokens: Migration = {
  down: `
    ALTER TABLE IF EXISTS brainstrike_assistant_run_usage
      DROP COLUMN IF EXISTS cache_read_input_tokens;
    ALTER TABLE IF EXISTS brainstrike_assistant_run_usage
      DROP COLUMN IF EXISTS cache_creation_input_tokens;
  `,
  ledgerKey: 'custom-069-run-usage-cache-tokens',
  name: 'run_usage_cache_tokens',
  up: `
    ALTER TABLE brainstrike_assistant_run_usage
      ADD COLUMN IF NOT EXISTS cache_read_input_tokens integer
      CHECK (cache_read_input_tokens >= 0);
    ALTER TABLE brainstrike_assistant_run_usage
      ADD COLUMN IF NOT EXISTS cache_creation_input_tokens integer
      CHECK (cache_creation_input_tokens >= 0);
  `,
  version: 69,
};
