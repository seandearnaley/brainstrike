import type { Migration } from './migration-runner';

/** Add xAI's Grok 4.6 route to the persisted OpenRouter model picker. */
export const migration100OpenRouterGrok46: Migration = {
  down: `
    DELETE FROM models
    WHERE provider_id = 'openrouter'
      AND id = 'x-ai/grok-4.6';
    UPDATE models SET sort_order = sort_order - 1 WHERE provider_id = 'openrouter';
  `,
  ledgerKey: 'custom-100-openrouter-grok-4-6',
  name: 'openrouter_grok_4_6',
  up: `
    UPDATE models SET sort_order = sort_order + 1 WHERE provider_id = 'openrouter';
    INSERT INTO models
      (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
    VALUES
      (
        'x-ai/grok-4.6',
        'openrouter',
        'Grok 4.6 (OpenRouter)',
        'Frontier multimodal reasoning for coding, agentic work, and STEM',
        '["Agentic coding", "Knowledge work", "Long-context reasoning"]',
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
  version: 100,
};
