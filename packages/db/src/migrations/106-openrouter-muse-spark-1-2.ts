import type { Migration } from './migration-runner';

/** Add Meta's Muse Spark 1.2 route to the persisted OpenRouter model picker. */
export const migration106OpenRouterMuseSpark12: Migration = {
  down: `
    DELETE FROM models
    WHERE provider_id = 'openrouter'
      AND id = 'meta/muse-spark-1.2';
    UPDATE models SET sort_order = sort_order - 1 WHERE provider_id = 'openrouter';
  `,
  ledgerKey: 'custom-106-openrouter-muse-spark-1-2',
  name: 'openrouter_muse_spark_1_2',
  up: `
    UPDATE models SET sort_order = sort_order + 1 WHERE provider_id = 'openrouter';
    INSERT INTO models
      (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
    VALUES
      (
        'meta/muse-spark-1.2',
        'openrouter',
        'Muse Spark 1.2 (OpenRouter)',
        'Optimized for real coding workflows, with higher first-attempt accuracy and more reliable tool calling',
        '["Multi-file refactors", "Long debugging sessions", "Whole-repository generation"]',
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
  version: 106,
};
