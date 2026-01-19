import type { Migration } from './migration-runner';

export const migration026UpdateProviderModels2026V2: Migration = {
  version: 26,
  name: 'update_provider_models_2026_v2',
  up: `
    -- Incremental catalog corrections for hosted providers
    UPDATE providers SET name = 'Google AI Studio' WHERE id = 'google';

    -- Remove invalid model IDs introduced in earlier drafts
    DELETE FROM models WHERE id IN (
      'gpt-5.2',
      'gpt-5.2-chat-latest',
      'gpt-5.2-pro',
      'claude-haiku-4-5',
      'claude-sonnet-4-5',
      'claude-opus-4-5',
      'claude-opus-4-5-20251101',
      'openai/gpt-5.2',
      'openai/gpt-5.2-chat-latest',
      'openai/gpt-5.2-pro',
      'anthropic/claude-haiku-4.5',
      'anthropic/claude-sonnet-4.5',
      'anthropic/claude-opus-4.5'
    );

    -- OpenAI (GPT-4o family + embeddings)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gpt-4o', 'openai', 'GPT-4o', 'Flagship multimodal model', '["Reasoning", "Coding", "Multimodal"]', '{"type":"llm","streaming":true}', 1, true),
      ('gpt-4o-mini', 'openai', 'GPT-4o Mini', 'Fast & cost-effective', '["Chat", "High throughput"]', '{"type":"llm","streaming":true}', 2, true),
      ('gpt-4-turbo', 'openai', 'GPT-4 Turbo', 'High-performance legacy model', '["Long context", "Instruction following"]', '{"type":"llm","streaming":true}', 3, false),
      ('text-embedding-3-small', 'openai', 'Text Embedding 3 Small', 'Efficient embeddings', '["Search", "Clustering"]', '{"type":"embedding","defaultDimension":1536}', 4, true),
      ('text-embedding-3-large', 'openai', 'Text Embedding 3 Large', 'High-precision embeddings', '["Semantic search", "Knowledge retrieval"]', '{"type":"embedding","defaultDimension":3072}', 5, false)
    ON CONFLICT (id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id,
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      best_for = EXCLUDED.best_for,
      capabilities = EXCLUDED.capabilities,
      sort_order = EXCLUDED.sort_order,
      is_enabled = EXCLUDED.is_enabled;

    -- Anthropic (Claude 4 + 3.5 series)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('claude-sonnet-4-20250514', 'anthropic', 'Claude Sonnet 4', 'Advanced reasoning', '["Analysis", "Coding", "Writing"]', '{"type":"llm","streaming":true}', 1, true),
      ('claude-3-5-haiku-20241022', 'anthropic', 'Claude 3.5 Haiku', 'Fastest Claude model', '["Quick responses", "Data extraction"]', '{"type":"llm","streaming":true}', 2, true),
      ('claude-opus-4-1-20250805', 'anthropic', 'Claude Opus 4.1', 'Highest quality Claude model', '["Deep research", "Complex tasks"]', '{"type":"llm","streaming":true}', 3, false)
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
      ('gemini-embedding-001', 'google', 'Gemini Embedding 001', 'Configurable embeddings', '["General purpose", "Retrieval"]', '{"type":"embedding","defaultDimension":3072}', 3, true),
      ('text-embedding-004', 'google', 'Text Embedding 004 (Deprecated)', 'Deprecated 768D embeddings (shutdown Jan 14, 2026)', '["Legacy collections"]', '{"type":"embedding","defaultDimension":768}', 4, false)
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
      ('openai/gpt-4o', 'openrouter', 'GPT-4o (OpenRouter)', 'Flagship OpenAI model', '["Reasoning", "Coding"]', '{"type":"llm","streaming":true}', 1, false),
      ('anthropic/claude-3.5-sonnet', 'openrouter', 'Claude 3.5 Sonnet (OpenRouter)', 'Balanced Claude model', '["Analysis", "Writing"]', '{"type":"llm","streaming":true}', 2, false),
      ('google/gemini-3-flash-preview', 'openrouter', 'Gemini 3 Flash (OpenRouter)', 'Low-latency Gemini preview', '["Realtime apps"]', '{"type":"llm","streaming":true}', 3, false)
    ON CONFLICT (id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id,
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      best_for = EXCLUDED.best_for,
      capabilities = EXCLUDED.capabilities,
      sort_order = EXCLUDED.sort_order,
      is_enabled = EXCLUDED.is_enabled;

    -- Ensure deprecated embeddings remain disabled
    UPDATE models SET is_enabled = false WHERE id = 'text-embedding-004';
  `,
  down: `
    -- Revert provider display name
    UPDATE providers SET name = 'Google' WHERE id = 'google';
  `,
};
