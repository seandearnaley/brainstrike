import type { Migration } from './migration-runner';

/** Add Qwen's text-only 2.4T A95B route to the persisted OpenRouter model picker. */
export const migration097OpenRouterQwen38TwoPointFourT: Migration = {
  down: `
    DELETE FROM models
    WHERE provider_id = 'openrouter'
      AND id = 'qwen/qwen3.8-2.4t-a95b';
    UPDATE models SET sort_order = sort_order - 1 WHERE provider_id = 'openrouter';
  `,
  ledgerKey: 'custom-097-openrouter-qwen-3-8-2-4t-a95b',
  name: 'openrouter_qwen_3_8_2_4t_a95b',
  up: `
    UPDATE models SET sort_order = sort_order + 1 WHERE provider_id = 'openrouter';
    INSERT INTO models
      (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
    VALUES
      (
        'qwen/qwen3.8-2.4t-a95b',
        'openrouter',
        'Qwen3.8 2.4T A95B (OpenRouter)',
        'Text-only mandatory-reasoning model for long agentic work',
        '["Agentic coding", "Complex reasoning", "Long-context workflows"]',
        '{"type":"llm","streaming":true,"vision":false}',
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
  version: 97,
};
