import type { Migration } from './migration-runner';

export const migration026UpdateProviderModels2026V2: Migration = {
  down: `
    -- Revert provider display name
    UPDATE providers SET name = 'Google' WHERE id = 'google';
  `,
  ledgerKey: 'custom-026-update-provider-models-2026-v2',
  name: 'update_provider_models_2026_v2',
  up: `
    -- Incremental catalog corrections for hosted providers
    -- NOTE: 025 shipped a full catalog replacement. This migration updates existing installs
    -- without wiping custom state or re-seeding identical rows.
    UPDATE providers SET name = 'Google AI Studio' WHERE id = 'google';

    -- Remove older-generation model IDs
    DELETE FROM models WHERE id IN (
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-3.5-turbo',
      'claude-3-5-haiku-latest',
      'claude-3-5-sonnet-latest',
      'claude-3-opus-latest',
      'claude-sonnet-4-20250514',
      'claude-3-5-haiku-20241022',
      'claude-opus-4-1-20250805',
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-5-20251101',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-2.0-pro',
      'gemini-1.5-pro',
      'text-embedding-004',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'openai/gpt-4-turbo',
      'openai/gpt-3.5-turbo',
      'anthropic/claude-3.5-sonnet',
      'google/gemini-2.5-flash',
      'google/gemini-2.5-pro'
    );

    -- OpenAI (GPT-5.2 family + embeddings)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gpt-5.2', 'openai', 'GPT-5.2', 'Latest-generation flagship model', '["Reasoning", "Coding", "Multimodal"]', '{"type":"llm","streaming":true}', 1, true),
      ('gpt-5.2-chat-latest', 'openai', 'GPT-5.2 Chat (Latest)', 'Optimized chat alias', '["Chat", "Fast iteration"]', '{"type":"llm","streaming":true}', 2, true),
      ('gpt-5.2-pro', 'openai', 'GPT-5.2 Pro', 'Higher capability tier', '["Complex reasoning", "Tool use"]', '{"type":"llm","streaming":true}', 3, true),
      ('text-embedding-3-small', 'openai', 'Text Embedding 3 Small', 'Efficient embeddings', '["Search", "Clustering"]', '{"type":"embedding","defaultDimension":1536}', 4, true),
      ('text-embedding-3-large', 'openai', 'Text Embedding 3 Large', 'High-precision embeddings', '["Semantic search", "Knowledge retrieval"]', '{"type":"embedding","defaultDimension":3072}', 5, true)
    ON CONFLICT (id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id,
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      best_for = EXCLUDED.best_for,
      capabilities = EXCLUDED.capabilities,
      sort_order = EXCLUDED.sort_order,
      is_enabled = EXCLUDED.is_enabled;

    -- Anthropic (Claude 4.5 series, alias IDs)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('claude-sonnet-4-5', 'anthropic', 'Claude Sonnet 4.5', 'Advanced reasoning', '["Analysis", "Coding", "Writing"]', '{"type":"llm","streaming":true}', 1, true),
      ('claude-haiku-4-5', 'anthropic', 'Claude Haiku 4.5', 'Fastest Claude model', '["Quick responses", "Data extraction"]', '{"type":"llm","streaming":true}', 2, true),
      ('claude-opus-4-5', 'anthropic', 'Claude Opus 4.5', 'Highest quality Claude model', '["Deep research", "Complex tasks"]', '{"type":"llm","streaming":true}', 3, true)
    ON CONFLICT (id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id,
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      best_for = EXCLUDED.best_for,
      capabilities = EXCLUDED.capabilities,
      sort_order = EXCLUDED.sort_order,
      is_enabled = EXCLUDED.is_enabled;

    -- Google (Gemini 3 preview + embeddings)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gemini-3-flash-preview', 'google', 'Gemini 3 Flash (Preview)', 'Low-latency preview model', '["Realtime apps", "High volume"]', '{"type":"llm","streaming":true}', 1, true),
      ('gemini-3-pro-preview', 'google', 'Gemini 3 Pro (Preview)', 'Advanced reasoning preview', '["Complex tasks", "Analysis"]', '{"type":"llm","streaming":true}', 2, true),
      ('gemini-embedding-001', 'google', 'Gemini Embedding 001', 'Configurable embeddings', '["General purpose", "Retrieval"]', '{"type":"embedding","defaultDimension":3072}', 3, true)
    ON CONFLICT (id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id,
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      best_for = EXCLUDED.best_for,
      capabilities = EXCLUDED.capabilities,
      sort_order = EXCLUDED.sort_order,
      is_enabled = EXCLUDED.is_enabled;

    -- OpenRouter (gateway, use provider-prefixed model IDs)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('openai/gpt-5.2', 'openrouter', 'GPT-5.2 (OpenRouter)', 'Latest-generation OpenAI model', '["Reasoning", "Coding"]', '{"type":"llm","streaming":true}', 1, false),
      ('anthropic/claude-sonnet-4.5', 'openrouter', 'Claude Sonnet 4.5 (OpenRouter)', 'Balanced Claude model', '["Analysis", "Writing"]', '{"type":"llm","streaming":true}', 2, false),
      ('google/gemini-3-flash-preview', 'openrouter', 'Gemini 3 Flash (OpenRouter)', 'Low-latency Gemini preview', '["Realtime apps"]', '{"type":"llm","streaming":true}', 3, false)
    ON CONFLICT (id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id,
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      best_for = EXCLUDED.best_for,
      capabilities = EXCLUDED.capabilities,
      sort_order = EXCLUDED.sort_order,
      is_enabled = EXCLUDED.is_enabled;

    -- Ensure removed embeddings are not present
    DELETE FROM models WHERE id = 'text-embedding-004';
  `,
  version: 26,
};
