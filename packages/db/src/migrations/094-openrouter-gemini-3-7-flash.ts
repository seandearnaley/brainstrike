import type { Migration } from './migration-runner';

/** Add Google's Gemini 3.7 Flash route to the persisted OpenRouter model picker. */
export const migration094OpenRouterGemini37Flash: Migration = {
  down: `
    DELETE FROM models
    WHERE provider_id = 'openrouter'
      AND id = 'google/gemini-3.7-flash';
    UPDATE models SET sort_order = sort_order - 1 WHERE provider_id = 'openrouter';
  `,
  ledgerKey: 'custom-094-openrouter-gemini-3-7-flash',
  name: 'openrouter_gemini_3_7_flash',
  up: `
    UPDATE models SET sort_order = sort_order + 1 WHERE provider_id = 'openrouter';
    INSERT INTO models
      (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
    VALUES
      (
        'google/gemini-3.7-flash',
        'openrouter',
        'Gemini 3.7 Flash (OpenRouter)',
        'Fast multimodal reasoning for agentic workflows',
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
  version: 94,
};
