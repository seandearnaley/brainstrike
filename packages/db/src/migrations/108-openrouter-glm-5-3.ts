import type { Migration } from './migration-runner';

/** Add Z.ai's GLM 5.3 route to the persisted OpenRouter model picker. */
export const migration108OpenRouterGlm53: Migration = {
  down: `
    DELETE FROM models
    WHERE provider_id = 'openrouter'
      AND id = 'z-ai/glm-5.3';
    UPDATE models SET sort_order = sort_order - 1 WHERE provider_id = 'openrouter';
  `,
  ledgerKey: 'custom-108-openrouter-glm-5-3',
  name: 'openrouter_glm_5_3',
  up: `
    UPDATE models SET sort_order = sort_order + 1 WHERE provider_id = 'openrouter';
    INSERT INTO models
      (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
    VALUES
      (
        'z-ai/glm-5.3',
        'openrouter',
        'GLM-5.3 (OpenRouter)',
        NULL,
        '[]',
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
  version: 108,
};
