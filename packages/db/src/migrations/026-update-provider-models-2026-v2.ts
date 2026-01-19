import type { Migration } from './migration-runner';

export const migration026UpdateProviderModels2026V2: Migration = {
  version: 26,
  name: 'update_provider_models_2026_v2',
  up: `
    -- Refresh hosted provider model catalogs with additional 2026 models
    DELETE FROM models WHERE provider_id IN ('openai', 'anthropic', 'google');

    -- OpenAI (GPT-5.2 series + embeddings)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gpt-5.2', 'openai', 'GPT-5.2', 'Frontier reasoning model', '["Reasoning", "Coding", "Analysis"]', '{"type":"llm","streaming":true}', 1, true),
      ('gpt-5.2-chat-latest', 'openai', 'GPT-5.2 Chat (Latest)', 'Chat-optimized GPT-5.2', '["Chat", "General assistance"]', '{"type":"llm","streaming":true}', 2, true),
      ('gpt-5.2-pro', 'openai', 'GPT-5.2 Pro', 'Highest quality GPT-5.2', '["Complex reasoning", "Expert tasks"]', '{"type":"llm","streaming":true}', 3, false),
      ('text-embedding-3-small', 'openai', 'Text Embedding 3 Small', 'Efficient embeddings', '["Search", "Clustering"]', '{"type":"embedding","defaultDimension":1536}', 4, true),
      ('text-embedding-3-large', 'openai', 'Text Embedding 3 Large', 'High-precision embeddings', '["Semantic search", "Knowledge retrieval"]', '{"type":"embedding","defaultDimension":3072}', 5, false);

    -- Anthropic (Claude 4.5 series)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('claude-haiku-4-5', 'anthropic', 'Claude Haiku 4.5', 'Fastest Claude 4.5', '["Quick responses", "Data extraction"]', '{"type":"llm","streaming":true}', 1, true),
      ('claude-sonnet-4-5', 'anthropic', 'Claude Sonnet 4.5', 'Balanced Claude 4.5', '["Analysis", "Coding", "Writing"]', '{"type":"llm","streaming":true}', 2, true),
      ('claude-opus-4-5', 'anthropic', 'Claude Opus 4.5', 'Highest quality Claude 4.5', '["Deep research", "Complex tasks"]', '{"type":"llm","streaming":true}', 3, false);

    -- Google (Gemini 3 + embeddings)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gemini-3-flash-preview', 'google', 'Gemini 3 Flash', 'Low-latency, high throughput', '["Realtime apps", "High volume"]', '{"type":"llm","streaming":true}', 1, true),
      ('gemini-3-pro-preview', 'google', 'Gemini 3 Pro (Preview)', 'Advanced reasoning', '["Complex tasks", "Analysis"]', '{"type":"llm","streaming":true}', 2, true),
      ('gemini-embedding-001', 'google', 'Gemini Embedding 001', 'Configurable embeddings', '["General purpose", "Retrieval"]', '{"type":"embedding","defaultDimension":3072}', 3, false);
  `,
  down: `
    -- Revert to initial 2026 model refresh catalog
    DELETE FROM models WHERE provider_id IN ('openai', 'anthropic', 'google');

    -- OpenAI (GPT-5.2 + embeddings)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gpt-5.2', 'openai', 'GPT-5.2', 'Frontier reasoning model', '["Reasoning", "Coding", "Analysis"]', '{"type":"llm","streaming":true}', 1, true),
      ('text-embedding-3-small', 'openai', 'Text Embedding 3 Small', 'Efficient embeddings', '["Search", "Clustering"]', '{"type":"embedding","defaultDimension":1536}', 2, true),
      ('text-embedding-3-large', 'openai', 'Text Embedding 3 Large', 'High-precision embeddings', '["Semantic search", "Knowledge retrieval"]', '{"type":"embedding","defaultDimension":3072}', 3, false);

    -- Anthropic (Claude 4.5)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('claude-haiku-4-5', 'anthropic', 'Claude Haiku 4.5', 'Fastest Claude 4.5', '["Quick responses", "Data extraction"]', '{"type":"llm","streaming":true}', 1, true);

    -- Google (Gemini 3 + embeddings)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gemini-3-flash-preview', 'google', 'Gemini 3 Flash', 'Low-latency, high throughput', '["Realtime apps", "High volume"]', '{"type":"llm","streaming":true}', 1, true),
      ('gemini-embedding-001', 'google', 'Gemini Embedding 001', 'Configurable embeddings', '["General purpose", "Retrieval"]', '{"type":"embedding","defaultDimension":3072}', 2, false);
  `,
};
