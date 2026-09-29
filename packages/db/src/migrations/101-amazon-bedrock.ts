import type { Migration } from './migration-runner';

/**
 * Amazon Bedrock provider + model catalog rows (BST-1350 phase 1).
 *
 * Mirrors the static registry's bedrock entry EXACTLY
 * (packages/assistant-contract/src/provider-registry.ts) — the catalog
 * contract script cross-checks both directions. Model ids are stored
 * UNPREFIXED (no cross-region us./eu. inference-profile prefix); the prefix
 * is a per-request routing concern (packages/agent bedrock-model-id.ts).
 * Vision is mirrored into the capabilities jsonb per the migration-061
 * contract. The provider row ships is_enabled=false like the openrouter seed
 * (keyed providers surface in DB-backed pickers via an explicit user toggle);
 * composer availability is preferences/registry-driven, so seeding rows
 * disabled preserves the existing new-row convention (migration 099).
 */
export const migration101AmazonBedrock: Migration = {
  down: `
    DELETE FROM models WHERE provider_id = 'bedrock';
    DELETE FROM providers WHERE id = 'bedrock';
  `,
  ledgerKey: 'custom-101-amazon-bedrock',
  name: 'amazon_bedrock',
  up: `
    INSERT INTO providers (id, name, sort_order, is_enabled) VALUES
      ('bedrock', 'Amazon Bedrock', 8, false)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      sort_order = EXCLUDED.sort_order,
      is_enabled = providers.is_enabled;

    INSERT INTO models
      (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
    VALUES
      (
        'anthropic.claude-fable-5',
        'bedrock',
        'Claude Fable 5 (Bedrock)',
        'Frontier Claude through AWS',
        '["Complex reasoning", "Coding", "Agentic workflows"]',
        '{"type":"llm","streaming":true,"vision":true}',
        1,
        false
      ),
      (
        'anthropic.claude-opus-4-8',
        'bedrock',
        'Claude Opus 4.8 (Bedrock)',
        'For your toughest challenges',
        '["Complex tasks", "Research", "Coding"]',
        '{"type":"llm","streaming":true,"vision":true}',
        2,
        false
      ),
      (
        'anthropic.claude-sonnet-5',
        'bedrock',
        'Claude Sonnet 5 (Bedrock)',
        'Best mix of smarts and speed',
        '["Coding", "Analysis", "Writing"]',
        '{"type":"llm","streaming":true,"vision":true}',
        3,
        false
      ),
      (
        'anthropic.claude-sonnet-4-6',
        'bedrock',
        'Claude Sonnet 4.6 (Bedrock)',
        'Balanced Claude model',
        '["Coding", "Analysis"]',
        '{"type":"llm","streaming":true,"vision":true}',
        4,
        false
      ),
      (
        'anthropic.claude-haiku-4-5-20251001-v1:0',
        'bedrock',
        'Claude Haiku 4.5 (Bedrock)',
        'Fastest for lightweight tasks',
        '["Quick responses", "High volume"]',
        '{"type":"llm","streaming":true,"vision":true}',
        5,
        false
      ),
      (
        'amazon.nova-pro-v1:0',
        'bedrock',
        'Amazon Nova Pro',
        'Capable multimodal Nova model',
        '["Multimodal", "Document analysis"]',
        '{"type":"llm","streaming":true,"vision":true}',
        6,
        false
      ),
      (
        'amazon.nova-lite-v1:0',
        'bedrock',
        'Amazon Nova Lite',
        'Low-cost multimodal Nova model',
        '["High throughput", "Multimodal"]',
        '{"type":"llm","streaming":true,"vision":true}',
        7,
        false
      ),
      (
        'amazon.nova-micro-v1:0',
        'bedrock',
        'Amazon Nova Micro',
        'Fastest text-only Nova model',
        '["Simple tasks", "Speed"]',
        '{"type":"llm","streaming":true,"vision":false}',
        8,
        false
      ),
      (
        'meta.llama4-maverick-17b-instruct-v1:0',
        'bedrock',
        'Llama 4 Maverick (Bedrock)',
        'Open-weight multimodal workhorse',
        '["General purpose", "Multimodal"]',
        '{"type":"llm","streaming":true,"vision":true}',
        9,
        false
      ),
      (
        'meta.llama4-scout-17b-instruct-v1:0',
        'bedrock',
        'Llama 4 Scout (Bedrock)',
        'Very long context, open weights',
        '["Long context", "Large codebases"]',
        '{"type":"llm","streaming":true,"vision":true}',
        10,
        false
      ),
      (
        'deepseek.v3.2',
        'bedrock',
        'DeepSeek V3.2 (Bedrock)',
        'Efficient open reasoning model',
        '["Reasoning", "Cost efficiency"]',
        '{"type":"llm","streaming":true,"vision":false}',
        11,
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
  version: 101,
};
