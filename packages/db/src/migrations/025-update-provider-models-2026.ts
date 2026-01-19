import type { Migration } from './migration-runner';

export const migration025UpdateProviderModels2026: Migration = {
  version: 25,
  name: 'update_provider_models_2026',
  up: `
    -- Replace hosted provider model catalogs (OpenAI, Anthropic, Google, OpenRouter)
    DELETE FROM models WHERE provider_id IN ('openai', 'anthropic', 'google', 'openrouter');

    -- OpenAI (GPT-4o family + embeddings)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gpt-4o', 'openai', 'GPT-4o', 'Flagship multimodal model', '["Reasoning", "Coding", "Multimodal"]', '{"type":"llm","streaming":true}', 1, true),
      ('gpt-4o-mini', 'openai', 'GPT-4o Mini', 'Fast & cost-effective', '["Chat", "High throughput"]', '{"type":"llm","streaming":true}', 2, true),
      ('gpt-4-turbo', 'openai', 'GPT-4 Turbo', 'High-performance legacy model', '["Long context", "Instruction following"]', '{"type":"llm","streaming":true}', 3, false),
      ('text-embedding-3-small', 'openai', 'Text Embedding 3 Small', 'Efficient embeddings', '["Search", "Clustering"]', '{"type":"embedding","defaultDimension":1536}', 4, true),
      ('text-embedding-3-large', 'openai', 'Text Embedding 3 Large', 'High-precision embeddings', '["Semantic search", "Knowledge retrieval"]', '{"type":"embedding","defaultDimension":3072}', 5, false);

    -- Anthropic (Claude 4 + 3.5 series)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('claude-sonnet-4-20250514', 'anthropic', 'Claude Sonnet 4', 'Advanced reasoning', '["Analysis", "Coding", "Writing"]', '{"type":"llm","streaming":true}', 1, true),
      ('claude-3-5-haiku-20241022', 'anthropic', 'Claude 3.5 Haiku', 'Fastest Claude model', '["Quick responses", "Data extraction"]', '{"type":"llm","streaming":true}', 2, true),
      ('claude-opus-4-1-20250805', 'anthropic', 'Claude Opus 4.1', 'Highest quality Claude model', '["Deep research", "Complex tasks"]', '{"type":"llm","streaming":true}', 3, false);

    -- Google (Gemini 3 preview + embeddings)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gemini-3-flash-preview', 'google', 'Gemini 3 Flash (Preview)', 'Low-latency preview model', '["Realtime apps", "High volume"]', '{"type":"llm","streaming":true}', 1, true),
      ('gemini-3-pro-preview', 'google', 'Gemini 3 Pro (Preview)', 'Advanced reasoning preview', '["Complex tasks", "Analysis"]', '{"type":"llm","streaming":true}', 2, true),
      ('gemini-embedding-001', 'google', 'Gemini Embedding 001', 'Configurable embeddings', '["General purpose", "Retrieval"]', '{"type":"embedding","defaultDimension":3072}', 3, true),
      ('text-embedding-004', 'google', 'Text Embedding 004 (Deprecated)', 'Deprecated 768D embeddings (shutdown Jan 14, 2026)', '["Legacy collections"]', '{"type":"embedding","defaultDimension":768}', 4, false);

    -- OpenRouter (gateway, use provider-prefixed model IDs)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('openai/gpt-4o', 'openrouter', 'GPT-4o (OpenRouter)', 'Flagship OpenAI model', '["Reasoning", "Coding"]', '{"type":"llm","streaming":true}', 1, false),
      ('anthropic/claude-3.5-sonnet', 'openrouter', 'Claude 3.5 Sonnet (OpenRouter)', 'Balanced Claude model', '["Analysis", "Writing"]', '{"type":"llm","streaming":true}', 2, false),
      ('google/gemini-3-flash-preview', 'openrouter', 'Gemini 3 Flash (OpenRouter)', 'Low-latency Gemini preview', '["Realtime apps"]', '{"type":"llm","streaming":true}', 3, false);
  `,
  down: `
    -- Restore previous hosted provider catalogs
    DELETE FROM models WHERE provider_id IN ('openai', 'anthropic', 'google', 'openrouter');

    -- OpenAI (previous catalog)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gpt-4o-mini', 'openai', 'GPT-4o Mini', 'Fast & cost-effective', '["Simple tasks", "High volume", "Speed"]', '{"type":"llm","streaming":true}', 1, true),
      ('gpt-4o', 'openai', 'GPT-4o', 'Most advanced multimodal model', '["Complex reasoning", "Coding", "Creative writing"]', '{"type":"llm","streaming":true}', 2, true),
      ('gpt-4-turbo', 'openai', 'GPT-4 Turbo', 'High-performance legacy model', '["Long context", "Instruction following"]', '{"type":"llm","streaming":true}', 3, false),
      ('gpt-3.5-turbo', 'openai', 'GPT-3.5 Turbo', 'Reliable workhorse', '["Chatbots", "Simple logic"]', '{"type":"llm","streaming":true}', 4, false),
      ('text-embedding-3-small', 'openai', 'Text Embedding 3 Small', 'Efficient embeddings', '["Search", "Clustering"]', '{"type":"embedding","defaultDimension":1536}', 5, true),
      ('text-embedding-3-large', 'openai', 'Text Embedding 3 Large', 'High-precision embeddings', '["Semantic search", "Knowledge retrieval"]', '{"type":"embedding","defaultDimension":3072}', 6, false);

    -- Anthropic (previous catalog)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('claude-3-5-haiku-latest', 'anthropic', 'Claude 3.5 Haiku', 'Fastest Claude model', '["Quick responses", "Data extraction"]', '{"type":"llm","streaming":true}', 1, true),
      ('claude-3-5-sonnet-latest', 'anthropic', 'Claude 3.5 Sonnet', 'Balanced intelligence & speed', '["Coding", "Analysis", "Writing"]', '{"type":"llm","streaming":true}', 2, true),
      ('claude-3-opus-latest', 'anthropic', 'Claude 3 Opus', 'Most powerful Claude model', '["Complex tasks", "Research"]', '{"type":"llm","streaming":true}', 3, false);

    -- Google (previous catalog)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gemini-2.5-flash', 'google', 'Gemini 2.5 Flash', 'Next-gen speed & efficiency', '["Real-time apps", "High throughput"]', '{"type":"llm","streaming":true}', 1, true),
      ('gemini-2.5-pro', 'google', 'Gemini 2.5 Pro', 'Advanced reasoning', '["Complex tasks", "Analysis"]', '{"type":"llm","streaming":true}', 2, true),
      ('gemini-embedding-001', 'google', 'Gemini Embedding 001', 'Legacy embeddings', '["Classification"]', '{"type":"embedding","defaultDimension":3072}', 3, true),
      ('text-embedding-004', 'google', 'Text Embedding 004 (Legacy)', 'Legacy 768D embeddings', '["Legacy collections"]', '{"type":"embedding","defaultDimension":768}', 4, false);

    -- OpenRouter (previous catalog)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('openai/gpt-4o-mini', 'openrouter', 'GPT-4o Mini (OpenRouter)', 'Fast & cost-effective', '["Simple tasks"]', '{"type":"llm","streaming":true}', 1, false),
      ('openai/gpt-4o', 'openrouter', 'GPT-4o (OpenRouter)', 'Most advanced multimodal model', '["Complex reasoning"]', '{"type":"llm","streaming":true}', 2, false),
      ('anthropic/claude-3.5-sonnet', 'openrouter', 'Claude 3.5 Sonnet (OpenRouter)', 'Balanced intelligence', '["Coding", "Analysis"]', '{"type":"llm","streaming":true}', 3, false);
  `,
};
