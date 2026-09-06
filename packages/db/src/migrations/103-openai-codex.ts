import type { Migration } from './migration-runner';

/**
 * OpenAI Codex (ChatGPT subscription) provider + model catalog rows
 * (BST-1356).
 *
 * Mirrors the static registry's `openai-codex` entry EXACTLY
 * (packages/assistant-contract/src/provider-registry.ts) — the catalog
 * contract script cross-checks both directions, and
 * `packages/db/__tests__/frontier-models-migration.test.ts` checks the
 * `vision` capability value-for-value against the registry.
 *
 * The model set is opencode's `ALLOWED_MODELS`, re-verified against
 * `anomalyco/opencode` `dev` HEAD 0033bb3559 on 2026-08-18 (legal gate
 * constraint 8). "Pro" reasoning routes and gpt-5.6 are excluded.
 *
 * Rows ship `is_enabled = false` like the openrouter and bedrock seeds;
 * enablement comes from `useOpenAiCodexDefaults` the first time a connected
 * subscription credential is present. `is_enabled = models.is_enabled` on
 * conflict preserves the USER's toggle on re-run — never
 * `EXCLUDED.is_enabled`, which would clobber it.
 */
export const migration103OpenAiCodex: Migration = {
  down: `
    DELETE FROM models WHERE provider_id = 'openai-codex';
    DELETE FROM providers WHERE id = 'openai-codex';
  `,
  ledgerKey: 'custom-103-openai-codex',
  name: 'openai_codex',
  up: `
    INSERT INTO providers (id, name, sort_order, is_enabled) VALUES
      ('openai-codex', 'OpenAI (ChatGPT)', 9, false)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      sort_order = EXCLUDED.sort_order,
      is_enabled = providers.is_enabled;

    INSERT INTO models
      (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
    VALUES
      (
        'codex/gpt-5.5',
        'openai-codex',
        'GPT-5.5',
        'Included with your ChatGPT subscription',
        '["Complex reasoning", "Coding", "Agentic workflows"]',
        '{"type":"llm","streaming":true,"vision":true}',
        1,
        false
      ),
      (
        'codex/gpt-5.4',
        'openai-codex',
        'GPT-5.4',
        'Included with your ChatGPT subscription',
        '["General purpose", "Coding"]',
        '{"type":"llm","streaming":true,"vision":true}',
        2,
        false
      ),
      (
        'codex/gpt-5.4-mini',
        'openai-codex',
        'GPT-5.4 Mini',
        'Faster, included with your ChatGPT subscription',
        '["Fast responses", "Everyday tasks"]',
        '{"type":"llm","streaming":true,"vision":true}',
        3,
        false
      ),
      (
        'codex/gpt-5.3-codex-spark',
        'openai-codex',
        'GPT-5.3 Codex Spark',
        'Lightweight coding, included with your ChatGPT subscription',
        '["Coding", "Cost efficiency"]',
        '{"type":"llm","streaming":true,"vision":true}',
        4,
        false
      )
    ON CONFLICT (id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id,
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      best_for = EXCLUDED.best_for,
      capabilities = EXCLUDED.capabilities,
      sort_order = EXCLUDED.sort_order,
      is_enabled = models.is_enabled;
  `,
  version: 103,
};
