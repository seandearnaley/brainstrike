import type { Migration } from './migration-runner';

/** Add InclusionAI's tool-capable Ling 3.0 Flash model to the persisted model picker. */
export const migration072OpenRouterLing3Flash: Migration = {
  down: `
    DELETE FROM models
    WHERE provider_id = 'openrouter'
      AND id = 'inclusionai/ling-3.0-flash:free';
    UPDATE models SET sort_order = sort_order - 1 WHERE provider_id = 'openrouter';
  `,
  ledgerKey: 'custom-072-openrouter-ling-3-flash',
  name: 'openrouter_ling_3_flash',
  up: `
    UPDATE models SET sort_order = sort_order + 1 WHERE provider_id = 'openrouter';
    INSERT INTO models
      (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
    VALUES
      (
        'inclusionai/ling-3.0-flash:free',
        'openrouter',
        'Ling 3.0 Flash Free (OpenRouter)',
        'Efficient agentic model from InclusionAI',
        '["Agentic workflows", "Tool use", "Cost-sensitive tasks"]',
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
  version: 72,
};
