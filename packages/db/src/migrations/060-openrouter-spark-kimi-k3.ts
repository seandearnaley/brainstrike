import type { Migration } from './migration-runner';

/** Add the July 16, 2026 OpenRouter launches to the persisted model picker. */
export const migration060OpenRouterSparkKimiK3: Migration = {
  down: `
    DELETE FROM models
    WHERE provider_id = 'openrouter'
      AND id IN ('meta/muse-spark-1.1', 'moonshotai/kimi-k3');
    UPDATE models SET sort_order = sort_order - 2 WHERE provider_id = 'openrouter';
  `,
  ledgerKey: 'custom-060-openrouter-spark-kimi-k3',
  name: 'openrouter_spark_kimi_k3',
  up: `
    UPDATE models SET sort_order = sort_order + 2 WHERE provider_id = 'openrouter';
    INSERT INTO models
      (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
    VALUES
      (
        'meta/muse-spark-1.1',
        'openrouter',
        'Muse Spark 1.1 (OpenRouter)',
        'Multimodal agentic reasoning from Meta',
        '["Agentic coding", "Tool use", "Multimodal workflows"]',
        '{"type":"llm","streaming":true}',
        1,
        false
      ),
      (
        'moonshotai/kimi-k3',
        'openrouter',
        'Kimi K3 (OpenRouter)',
        'Million-token multimodal reasoning model',
        '["Long-horizon coding", "Knowledge work", "Tool use"]',
        '{"type":"llm","streaming":true}',
        2,
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
  version: 60,
};
