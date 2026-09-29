import type { Migration } from './migration-runner';

export const migration025UpdateProviderModels2026: Migration = {
  down: `
    -- Restore hosted provider catalogs to pre-2026 model lineup
    DELETE FROM models WHERE provider_id IN ('openai', 'anthropic', 'google', 'openrouter');

    -- OpenAI (GPT-4o era + embeddings)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gpt-4o-mini', 'openai', 'GPT-4o Mini', 'Fast & cost-effective', '["Simple tasks", "High volume", "Speed"]', '{"type":"llm","streaming":true}', 1, true),
      ('gpt-4o', 'openai', 'GPT-4o', 'Most advanced multimodal model', '["Complex reasoning", "Coding", "Creative writing"]', '{"type":"llm","streaming":true}', 2, true),
      ('gpt-4-turbo', 'openai', 'GPT-4 Turbo', 'High-performance legacy model', '["Long context", "Instruction following"]', '{"type":"llm","streaming":true}', 3, false),
      ('gpt-3.5-turbo', 'openai', 'GPT-3.5 Turbo', 'Reliable workhorse', '["Chatbots", "Simple logic"]', '{"type":"llm","streaming":true}', 4, false),
      ('text-embedding-3-small', 'openai', 'Text Embedding 3 Small', 'Efficient embeddings', '["Search", "Clustering"]', '{"type":"embedding","defaultDimension":1536}', 5, true),
      ('text-embedding-3-large', 'openai', 'Text Embedding 3 Large', 'High-precision embeddings', '["Semantic search", "Knowledge retrieval"]', '{"type":"embedding","defaultDimension":3072}', 6, false);

    -- Anthropic (Claude 3.5 series)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('claude-3-5-haiku-latest', 'anthropic', 'Claude 3.5 Haiku', 'Fastest Claude model', '["Quick responses", "Data extraction"]', '{"type":"llm","streaming":true}', 1, true),
      ('claude-3-5-sonnet-latest', 'anthropic', 'Claude 3.5 Sonnet', 'Balanced intelligence & speed', '["Coding", "Analysis", "Writing"]', '{"type":"llm","streaming":true}', 2, true),
      ('claude-3-opus-latest', 'anthropic', 'Claude 3 Opus', 'Most powerful Claude model', '["Complex tasks", "Research"]', '{"type":"llm","streaming":true}', 3, false);

    -- Google (Gemini 2.x/1.5 + embeddings)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gemini-2.5-flash', 'google', 'Gemini 2.5 Flash', 'Next-gen speed & efficiency', '["Real-time apps", "High throughput"]', '{"type":"llm","streaming":true}', 1, true),
      ('gemini-2.0-pro', 'google', 'Gemini 2.0 Pro', 'Best-in-class reasoning', '["Complex problem solving", "Multimodal"]', '{"type":"llm","streaming":true}', 2, true),
      ('gemini-1.5-pro', 'google', 'Gemini 1.5 Pro', 'Long context window', '["Document analysis", "Large codebases"]', '{"type":"llm","streaming":true}', 3, false),
      ('gemini-embedding-001', 'google', 'Gemini Embedding 001', 'Legacy embeddings', '["Classification"]', '{"type":"embedding","defaultDimension":3072}', 4, false);

    -- OpenRouter (gateway, legacy lineup)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('openrouter/gpt-4o-mini', 'openrouter', 'GPT-4o Mini (OpenRouter)', 'Fast & cost-effective', '["Simple tasks"]', '{"type":"llm","streaming":true}', 1, false),
      ('openrouter/gpt-4o', 'openrouter', 'GPT-4o (OpenRouter)', 'Most advanced multimodal model', '["Complex reasoning"]', '{"type":"llm","streaming":true}', 2, false),
      ('openrouter/claude-3-5-sonnet', 'openrouter', 'Claude 3.5 Sonnet (OpenRouter)', 'Balanced intelligence', '["Coding", "Analysis"]', '{"type":"llm","streaming":true}', 3, false);
  `,
  ledgerKey: 'custom-025-update-provider-models-2026',
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
  version: 25,
};
