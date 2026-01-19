import type { Migration } from './migration-runner';

export const migration025UpdateProviderModels2026: Migration = {
  version: 25,
  name: 'update_provider_models_2026',
  up: `
    -- Replace hosted provider model catalogs (OpenAI, Anthropic, Google, OpenRouter)
    DELETE FROM models WHERE provider_id IN ('openai', 'anthropic', 'google', 'openrouter');

    -- OpenAI (GPT-5.2 family + embeddings)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gpt-5.2', 'openai', 'GPT-5.2', 'Latest-generation flagship model', '["Reasoning", "Coding", "Multimodal"]', '{"type":"llm","streaming":true}', 1, true),
      ('gpt-5.2-chat-latest', 'openai', 'GPT-5.2 Chat (Latest)', 'Optimized chat alias', '["Chat", "Fast iteration"]', '{"type":"llm","streaming":true}', 2, true),
      ('gpt-5.2-pro', 'openai', 'GPT-5.2 Pro', 'Higher capability tier', '["Complex reasoning", "Tool use"]', '{"type":"llm","streaming":true}', 3, true),
      ('text-embedding-3-small', 'openai', 'Text Embedding 3 Small', 'Efficient embeddings', '["Search", "Clustering"]', '{"type":"embedding","defaultDimension":1536}', 4, true),
      ('text-embedding-3-large', 'openai', 'Text Embedding 3 Large', 'High-precision embeddings', '["Semantic search", "Knowledge retrieval"]', '{"type":"embedding","defaultDimension":3072}', 5, true);

    -- Anthropic (Claude 4.5 series, alias IDs)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('claude-sonnet-4-5', 'anthropic', 'Claude Sonnet 4.5', 'Advanced reasoning', '["Analysis", "Coding", "Writing"]', '{"type":"llm","streaming":true}', 1, true),
      ('claude-haiku-4-5', 'anthropic', 'Claude Haiku 4.5', 'Fastest Claude model', '["Quick responses", "Data extraction"]', '{"type":"llm","streaming":true}', 2, true),
      ('claude-opus-4-5', 'anthropic', 'Claude Opus 4.5', 'Highest quality Claude model', '["Deep research", "Complex tasks"]', '{"type":"llm","streaming":true}', 3, true);

    -- Google (Gemini 3 preview + embeddings)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gemini-3-flash-preview', 'google', 'Gemini 3 Flash (Preview)', 'Low-latency preview model', '["Realtime apps", "High volume"]', '{"type":"llm","streaming":true}', 1, true),
      ('gemini-3-pro-preview', 'google', 'Gemini 3 Pro (Preview)', 'Advanced reasoning preview', '["Complex tasks", "Analysis"]', '{"type":"llm","streaming":true}', 2, true),
      ('gemini-embedding-001', 'google', 'Gemini Embedding 001', 'Configurable embeddings', '["General purpose", "Retrieval"]', '{"type":"embedding","defaultDimension":3072}', 3, true);

    -- OpenRouter (gateway, use provider-prefixed model IDs)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('openai/gpt-5.2', 'openrouter', 'GPT-5.2 (OpenRouter)', 'Latest-generation OpenAI model', '["Reasoning", "Coding"]', '{"type":"llm","streaming":true}', 1, false),
      ('anthropic/claude-sonnet-4.5', 'openrouter', 'Claude Sonnet 4.5 (OpenRouter)', 'Balanced Claude model', '["Analysis", "Writing"]', '{"type":"llm","streaming":true}', 2, false),
      ('google/gemini-3-flash-preview', 'openrouter', 'Gemini 3 Flash (OpenRouter)', 'Low-latency Gemini preview', '["Realtime apps"]', '{"type":"llm","streaming":true}', 3, false);
  `,
  down: `
    -- Restore hosted provider catalogs (2026)
    DELETE FROM models WHERE provider_id IN ('openai', 'anthropic', 'google', 'openrouter');

    -- OpenAI (GPT-5.2 family + embeddings)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gpt-5.2', 'openai', 'GPT-5.2', 'Latest-generation flagship model', '["Reasoning", "Coding", "Multimodal"]', '{"type":"llm","streaming":true}', 1, true),
      ('gpt-5.2-chat-latest', 'openai', 'GPT-5.2 Chat (Latest)', 'Optimized chat alias', '["Chat", "Fast iteration"]', '{"type":"llm","streaming":true}', 2, true),
      ('gpt-5.2-pro', 'openai', 'GPT-5.2 Pro', 'Higher capability tier', '["Complex reasoning", "Tool use"]', '{"type":"llm","streaming":true}', 3, true),
      ('text-embedding-3-small', 'openai', 'Text Embedding 3 Small', 'Efficient embeddings', '["Search", "Clustering"]', '{"type":"embedding","defaultDimension":1536}', 4, true),
      ('text-embedding-3-large', 'openai', 'Text Embedding 3 Large', 'High-precision embeddings', '["Semantic search", "Knowledge retrieval"]', '{"type":"embedding","defaultDimension":3072}', 5, true);

    -- Anthropic (Claude 4.5 series, alias IDs)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('claude-sonnet-4-5', 'anthropic', 'Claude Sonnet 4.5', 'Advanced reasoning', '["Analysis", "Coding", "Writing"]', '{"type":"llm","streaming":true}', 1, true),
      ('claude-haiku-4-5', 'anthropic', 'Claude Haiku 4.5', 'Fastest Claude model', '["Quick responses", "Data extraction"]', '{"type":"llm","streaming":true}', 2, true),
      ('claude-opus-4-5', 'anthropic', 'Claude Opus 4.5', 'Highest quality Claude model', '["Deep research", "Complex tasks"]', '{"type":"llm","streaming":true}', 3, true);

    -- Google (Gemini 3 preview + embeddings)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gemini-3-flash-preview', 'google', 'Gemini 3 Flash (Preview)', 'Low-latency preview model', '["Realtime apps", "High volume"]', '{"type":"llm","streaming":true}', 1, true),
      ('gemini-3-pro-preview', 'google', 'Gemini 3 Pro (Preview)', 'Advanced reasoning preview', '["Complex tasks", "Analysis"]', '{"type":"llm","streaming":true}', 2, true),
      ('gemini-embedding-001', 'google', 'Gemini Embedding 001', 'Configurable embeddings', '["General purpose", "Retrieval"]', '{"type":"embedding","defaultDimension":3072}', 3, true);

    -- OpenRouter (gateway, use provider-prefixed model IDs)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('openai/gpt-5.2', 'openrouter', 'GPT-5.2 (OpenRouter)', 'Latest-generation OpenAI model', '["Reasoning", "Coding"]', '{"type":"llm","streaming":true}', 1, false),
      ('anthropic/claude-sonnet-4.5', 'openrouter', 'Claude Sonnet 4.5 (OpenRouter)', 'Balanced Claude model', '["Analysis", "Writing"]', '{"type":"llm","streaming":true}', 2, false),
      ('google/gemini-3-flash-preview', 'openrouter', 'Gemini 3 Flash (OpenRouter)', 'Low-latency Gemini preview', '["Realtime apps"]', '{"type":"llm","streaming":true}', 3, false);
  `,
};
