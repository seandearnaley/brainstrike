import type { Migration } from './migration-runner';

/** Add NVIDIA's Nemotron 3.5 Lightning route to the persisted OpenRouter picker. */
export const migration099OpenRouterNemotron35Lightning: Migration = {
  down: `
    DELETE FROM models
    WHERE provider_id = 'openrouter'
      AND id = 'nvidia/nemotron-3.5-lightning';
    UPDATE models SET sort_order = sort_order - 1 WHERE provider_id = 'openrouter';
  `,
  ledgerKey: 'custom-099-openrouter-nemotron-3-5-lightning',
  name: 'openrouter_nemotron_3_5_lightning',
  up: `
    UPDATE models SET sort_order = sort_order + 1 WHERE provider_id = 'openrouter';
    INSERT INTO models
      (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
    VALUES
      (
        'nvidia/nemotron-3.5-lightning',
        'openrouter',
        'Nemotron 3.5 Lightning (OpenRouter)',
        'Efficient open reasoning for high-throughput agentic workloads',
        '["Agentic workflows", "Long-context text", "Tool calling"]',
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
  version: 99,
};
