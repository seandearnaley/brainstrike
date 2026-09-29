import type { Migration } from './migration-runner';

export const migration015ModelRegistry: Migration = {
  down: `
    DROP TABLE IF EXISTS models;
    DROP TABLE IF EXISTS providers;
  `,
  ledgerKey: 'custom-015-model-registry-seed',
  name: 'model_registry',
  up: `
    -- Create providers table
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      is_enabled BOOLEAN NOT NULL DEFAULT false,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Create models table
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      tagline TEXT,
      best_for JSONB,
      icon TEXT,
      is_enabled BOOLEAN NOT NULL DEFAULT false,
      capabilities JSONB,
      parameters JSONB,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Create indexes
    CREATE INDEX IF NOT EXISTS idx_models_provider_id ON models(provider_id);
    CREATE INDEX IF NOT EXISTS idx_providers_sort_order ON providers(sort_order);
    CREATE INDEX IF NOT EXISTS idx_models_sort_order ON models(sort_order);

    -- Seed Providers
    INSERT INTO providers (id, name, sort_order, is_enabled) VALUES
      ('openai', 'OpenAI', 1, true),
      ('anthropic', 'Anthropic', 2, true),
      ('google', 'Google', 3, true),
      ('transformers', 'Local Models', 4, true),
      ('openrouter', 'OpenRouter', 5, false),
      ('cohere', 'Cohere', 6, false),
      ('voyage', 'Voyage AI', 7, false);

    -- Seed Models (OpenAI)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gpt-4o-mini', 'openai', 'GPT-4o Mini', 'Fast & cost-effective', '["Simple tasks", "High volume", "Speed"]', '{"type":"llm","streaming":true}', 1, true),
      ('gpt-4o', 'openai', 'GPT-4o', 'Most advanced multimodal model', '["Complex reasoning", "Coding", "Creative writing"]', '{"type":"llm","streaming":true}', 2, true),
      ('gpt-4-turbo', 'openai', 'GPT-4 Turbo', 'High-performance legacy model', '["Long context", "Instruction following"]', '{"type":"llm","streaming":true}', 3, false),
      ('gpt-3.5-turbo', 'openai', 'GPT-3.5 Turbo', 'Reliable workhorse', '["Chatbots", "Simple logic"]', '{"type":"llm","streaming":true}', 4, false),
      ('text-embedding-3-small', 'openai', 'Text Embedding 3 Small', 'Efficient embeddings', '["Search", "Clustering"]', '{"type":"embedding","defaultDimension":1536}', 5, true),
      ('text-embedding-3-large', 'openai', 'Text Embedding 3 Large', 'High-precision embeddings', '["Semantic search", "Knowledge retrieval"]', '{"type":"embedding","defaultDimension":3072}', 6, false);

    -- Seed Models (Anthropic)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('claude-3-5-haiku-latest', 'anthropic', 'Claude 3.5 Haiku', 'Fastest Claude model', '["Quick responses", "Data extraction"]', '{"type":"llm","streaming":true}', 1, true),
      ('claude-3-5-sonnet-latest', 'anthropic', 'Claude 3.5 Sonnet', 'Balanced intelligence & speed', '["Coding", "Analysis", "Writing"]', '{"type":"llm","streaming":true}', 2, true),
      ('claude-3-opus-latest', 'anthropic', 'Claude 3 Opus', 'Most powerful Claude model', '["Complex tasks", "Research"]', '{"type":"llm","streaming":true}', 3, false);

    -- Seed Models (Google)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gemini-2.5-flash', 'google', 'Gemini 2.5 Flash', 'Next-gen speed & efficiency', '["Real-time apps", "High throughput"]', '{"type":"llm","streaming":true}', 1, true),
      ('gemini-2.0-pro', 'google', 'Gemini 2.0 Pro', 'Best-in-class reasoning', '["Complex problem solving", "Multimodal"]', '{"type":"llm","streaming":true}', 2, true),
      ('gemini-1.5-pro', 'google', 'Gemini 1.5 Pro', 'Long context window', '["Document analysis", "Large codebases"]', '{"type":"llm","streaming":true}', 3, false),
      ('gemini-embedding-001', 'google', 'Gemini Embedding 001', 'Legacy embeddings', '["Classification"]', '{"type":"embedding","defaultDimension":3072}', 4, false);

    -- Seed Models (Local / Transformers)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, parameters, sort_order, is_enabled) VALUES
      ('jinaai/jina-embeddings-v2-base-code', 'transformers', 'Jina Code', 'Code-aware embeddings', '["Code search", "Multilingual"]', '{"type":"embedding","defaultDimension":768}', '{"size":"~300MB"}', 1, false),
      ('Xenova/jina-embeddings-v2-base-en', 'transformers', 'Jina v2 Base EN', 'Best English model', '["English", "High performance"]', '{"type":"embedding","defaultDimension":768}', '{"size":"~300MB"}', 2, false),
      ('Xenova/all-MiniLM-L6-v2', 'transformers', 'all-MiniLM-L6-v2', 'Fast & efficient', '["English", "Speed"]', '{"type":"embedding","defaultDimension":384}', '{"size":"~23MB"}', 3, false),
      ('Xenova/bge-small-en-v1.5', 'transformers', 'BGE Small', 'Balanced performance', '["English", "General purpose"]', '{"type":"embedding","defaultDimension":384}', '{"size":"~34MB"}', 4, false),
      ('Xenova/bge-base-en-v1.5', 'transformers', 'BGE Base', 'High quality', '["English", "Retrieval"]', '{"type":"embedding","defaultDimension":768}', '{"size":"~110MB"}', 5, false),
      ('Xenova/bge-large-en-v1.5', 'transformers', 'BGE Large', 'SOTA performance', '["English", "High accuracy"]', '{"type":"embedding","defaultDimension":1024}', '{"size":"~340MB"}', 6, false);

    -- Seed Models (OpenRouter)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('openrouter/gpt-4o-mini', 'openrouter', 'GPT-4o Mini (OpenRouter)', 'Fast & cost-effective', '["Simple tasks"]', '{"type":"llm","streaming":true}', 1, false),
      ('openrouter/gpt-4o', 'openrouter', 'GPT-4o (OpenRouter)', 'Most advanced multimodal model', '["Complex reasoning"]', '{"type":"llm","streaming":true}', 2, false),
      ('openrouter/claude-3-5-sonnet', 'openrouter', 'Claude 3.5 Sonnet (OpenRouter)', 'Balanced intelligence', '["Coding", "Analysis"]', '{"type":"llm","streaming":true}', 3, false);

    -- Seed Models (Cohere)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('embed-english-v3.0', 'cohere', 'Embed English v3.0', 'Optimized for English', '["Search", "RAG"]', '{"type":"embedding","defaultDimension":1024}', 1, false),
      ('embed-multilingual-v3.0', 'cohere', 'Embed Multilingual v3.0', '100+ languages supported', '["Global apps", "Cross-lingual search"]', '{"type":"embedding","defaultDimension":1024}', 2, false);

    -- Seed Models (Voyage)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('voyage-3', 'voyage', 'Voyage 3', 'State-of-the-art retrieval', '["Legal", "Finance", "Code"]', '{"type":"embedding","defaultDimension":1024}', 1, false),
      ('voyage-3-lite', 'voyage', 'Voyage 3 Lite', 'Efficient retrieval', '["Low latency apps"]', '{"type":"embedding","defaultDimension":512}', 2, false);
  `,
  version: 15,
};
