import type { Migration } from './migration-runner';

/** Add Alibaba's Qwen3.8 Max route to the persisted OpenRouter model picker. */
export const migration098OpenRouterQwen38Max: Migration = {
  down: `
    DELETE FROM models
    WHERE provider_id = 'openrouter'
      AND id = 'qwen/qwen3.8-max';
    UPDATE models SET sort_order = sort_order - 1 WHERE provider_id = 'openrouter';
  `,
  ledgerKey: 'custom-098-openrouter-qwen-3-8-max',
  name: 'openrouter_qwen_3_8_max',
  up: `
    UPDATE models SET sort_order = sort_order + 1 WHERE provider_id = 'openrouter';
    INSERT INTO models
      (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
    VALUES
      (
        'qwen/qwen3.8-max',
        'openrouter',
        'Qwen3.8 Max (OpenRouter)',
        'Flagship multimodal reasoning with a 1M-token context window',
        '["Long-context work", "Multimodal reasoning", "Tool calling"]',
        '{"type":"llm","streaming":true,"vision":true}',
        1,
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
  version: 98,
};
