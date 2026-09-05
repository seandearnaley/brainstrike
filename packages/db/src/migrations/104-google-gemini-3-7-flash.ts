import type { Migration } from './migration-runner';

/** Add Gemini 3.7 Flash to the persisted direct Google model picker. */
export const migration104GoogleGemini37Flash: Migration = {
  down: `
    DELETE FROM models
    WHERE provider_id = 'google'
      AND id = 'gemini-3.7-flash';
    UPDATE models SET sort_order = sort_order - 1 WHERE provider_id = 'google';
  `,
  ledgerKey: 'custom-104-google-gemini-3-7-flash',
  name: 'google_gemini_3_7_flash',
  up: `
    UPDATE models SET sort_order = sort_order + 1 WHERE provider_id = 'google';
    INSERT INTO models
      (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
    VALUES
      (
        'gemini-3.7-flash',
        'google',
        'Gemini 3.7 Flash',
        'Fast multimodal reasoning for complex agentic workflows',
        '["Code generation", "Spatial/multimodal reasoning", "Multi-step agentic workflows"]',
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
  version: 104,
};
