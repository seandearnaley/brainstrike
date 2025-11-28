import type { Migration } from './migration-runner';

export const migration015ModelRegistry: Migration = {
  version: 15,
  name: 'model_registry',
  up: `
    -- Create providers table
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      is_enabled BOOLEAN NOT NULL DEFAULT true,
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
      is_enabled BOOLEAN NOT NULL DEFAULT true,
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
    INSERT INTO providers (id, name, sort_order) VALUES
      ('openai', 'OpenAI', 1),
      ('anthropic', 'Anthropic', 2),
      ('google', 'Google', 3),
      ('openrouter', 'OpenRouter', 4),
      ('cohere', 'Cohere', 5),
      ('voyage', 'Voyage AI', 6);

    -- Seed Models (OpenAI)
    INSERT INTO models (id, provider_id, name, capabilities, sort_order) VALUES
      ('gpt-4o-mini', 'openai', 'GPT-4o Mini', '{"type":"llm","streaming":true}', 1),
      ('gpt-4o', 'openai', 'GPT-4o', '{"type":"llm","streaming":true}', 2),
      ('gpt-4-turbo', 'openai', 'GPT-4 Turbo', '{"type":"llm","streaming":true}', 3),
      ('gpt-3.5-turbo', 'openai', 'GPT-3.5 Turbo', '{"type":"llm","streaming":true}', 4),
      ('text-embedding-3-small', 'openai', 'Text Embedding 3 Small', '{"type":"embedding","defaultDimension":1536}', 5),
      ('text-embedding-3-large', 'openai', 'Text Embedding 3 Large', '{"type":"embedding","defaultDimension":3072}', 6);

    -- Seed Models (Anthropic)
    INSERT INTO models (id, provider_id, name, capabilities, sort_order) VALUES
      ('claude-3-5-haiku-latest', 'anthropic', 'Claude 3.5 Haiku', '{"type":"llm","streaming":true}', 1),
      ('claude-3-5-sonnet-latest', 'anthropic', 'Claude 3.5 Sonnet', '{"type":"llm","streaming":true}', 2),
      ('claude-3-opus-latest', 'anthropic', 'Claude 3 Opus', '{"type":"llm","streaming":true}', 3);

    -- Seed Models (Google)
    INSERT INTO models (id, provider_id, name, capabilities, sort_order) VALUES
      ('gemini-2.5-flash', 'google', 'Gemini 2.5 Flash', '{"type":"llm","streaming":true}', 1),
      ('gemini-2.0-pro', 'google', 'Gemini 2.0 Pro', '{"type":"llm","streaming":true}', 2),
      ('gemini-1.5-pro', 'google', 'Gemini 1.5 Pro', '{"type":"llm","streaming":true}', 3),
      ('text-embedding-004', 'google', 'Text Embedding 004', '{"type":"embedding","defaultDimension":768}', 4),
      ('gemini-embedding-001', 'google', 'Gemini Embedding 001', '{"type":"embedding","defaultDimension":3072}', 5);

    -- Seed Models (OpenRouter)
    INSERT INTO models (id, provider_id, name, capabilities, sort_order) VALUES
      ('openrouter/gpt-4o-mini', 'openrouter', 'GPT-4o Mini (OpenRouter)', '{"type":"llm","streaming":true}', 1),
      ('openrouter/gpt-4o', 'openrouter', 'GPT-4o (OpenRouter)', '{"type":"llm","streaming":true}', 2),
      ('openrouter/claude-3-5-sonnet', 'openrouter', 'Claude 3.5 Sonnet (OpenRouter)', '{"type":"llm","streaming":true}', 3);

    -- Seed Models (Cohere)
    INSERT INTO models (id, provider_id, name, capabilities, sort_order) VALUES
      ('embed-english-v3.0', 'cohere', 'Embed English v3.0', '{"type":"embedding","defaultDimension":1024}', 1),
      ('embed-multilingual-v3.0', 'cohere', 'Embed Multilingual v3.0', '{"type":"embedding","defaultDimension":1024}', 2);

    -- Seed Models (Voyage)
    INSERT INTO models (id, provider_id, name, capabilities, sort_order) VALUES
      ('voyage-3', 'voyage', 'Voyage 3', '{"type":"embedding","defaultDimension":1024}', 1),
      ('voyage-3-lite', 'voyage', 'Voyage 3 Lite', '{"type":"embedding","defaultDimension":512}', 2);
  `,
  down: `
    DROP TABLE IF EXISTS models;
    DROP TABLE IF EXISTS providers;
  `,
};
