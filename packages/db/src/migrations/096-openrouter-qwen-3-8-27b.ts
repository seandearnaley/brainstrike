import type { Migration } from './migration-runner';

/** Add Qwen3.8 27B to the persisted OpenRouter model picker. */
export const migration096OpenRouterQwen3827B: Migration = {
  down: `
    DELETE FROM models
    WHERE provider_id = 'openrouter'
      AND id = 'qwen/qwen3.8-27b';
    UPDATE models SET sort_order = sort_order - 1 WHERE provider_id = 'openrouter';
  `,
  ledgerKey: 'custom-096-openrouter-qwen-3-8-27b',
  name: 'openrouter_qwen_3_8_27b',
  up: `
    UPDATE models SET sort_order = sort_order + 1 WHERE provider_id = 'openrouter';
    INSERT INTO models
      (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
    VALUES
      (
        'qwen/qwen3.8-27b',
        'openrouter',
        'Qwen3.8 27B (OpenRouter)',
        'Multimodal reasoning for coding and long-horizon agents',
        '["Agentic workflows", "Coding", "Multimodal reasoning"]',
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
  version: 96,
};
