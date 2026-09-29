import type { Migration } from './migration-runner';

/** Add Alibaba's Qwen3.8 Flash route to the persisted OpenRouter model picker. */
export const migration113OpenRouterQwen38Flash: Migration = {
  down: `
    DELETE FROM models
    WHERE provider_id = 'openrouter'
      AND id = 'qwen/qwen3.8-flash';
  `,
  ledgerKey: 'custom-113-openrouter-qwen-3-8-flash',
  name: 'openrouter_qwen_3_8_flash',
  up: `
    INSERT INTO models
      (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
    VALUES
      (
        'qwen/qwen3.8-flash',
        'openrouter',
        'Qwen3.8 Flash (OpenRouter)',
        NULL,
        '[]',
        '{"type":"llm","streaming":true,"vision":true}',
        0,
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
  version: 113,
};
