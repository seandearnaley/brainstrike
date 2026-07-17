import type { Migration } from './migration-runner';

// Refreshes the hosted-provider model catalog to the May 2026 frontier lineup.
// Mirrors the static registry in
// packages/assistant-contract/src/provider-registry.ts. Existing user
// `is_enabled` choices on kept rows are preserved (DO UPDATE keeps the prior
// value); brand-new hosted rows arrive enabled so users get the fresh
// selection without re-enabling each model.
//
// INVARIANT: every upsert below sets `is_enabled = models.is_enabled` to keep
// the user's toggle. A future migration that must force a model on/off (e.g. a
// security-driven swap) has to set `is_enabled` explicitly for those rows
// instead of copying this clause.
export const migration033UpdateProviderModels2026Frontier: Migration = {
  down: `
    -- Delete the rows 033 newly introduced. Note the gemini-2.5-* models: 025
    -- seeded them and 026 deleted them, so they are ABSENT in the pre-033
    -- (post-026) state. 033 re-introduces them as first-class, so rolling back
    -- correctly removes them again. (Pre-existing rows like gpt-5.2-pro are not
    -- listed here — they are metadata-restored by the INSERT below instead.)
    DELETE FROM models WHERE id IN (
      'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.3-codex',
      'claude-opus-4-8', 'claude-sonnet-4-6',
      'gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-embedding-2',
      'openai/gpt-5.5', 'openai/gpt-5.4', 'openai/gpt-5.4-mini', 'openai/gpt-5.3-codex',
      'anthropic/claude-opus-4.8', 'anthropic/claude-sonnet-4.6', 'anthropic/claude-haiku-4.5',
      'google/gemini-3.5-flash', 'google/gemini-3.1-pro-preview', 'google/gemini-2.5-flash'
    );

    -- Faithfully restore the pre-033 (025/026-era) hosted catalog so a rollback
    -- reproduces the version-32 state. This covers BOTH the models 033 removed
    -- AND the kept rows whose metadata/sort_order 033's upsert overwrote
    -- (e.g. gpt-5.2-pro, which predates 033 via migration 026 and must NOT be
    -- deleted). DO UPDATE restores the prior column values; is_enabled is left
    -- at the row's current value to preserve any user toggle on still-present
    -- rows (re-created rows take the 026 default in VALUES).
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gpt-5.2', 'openai', 'GPT-5.2', 'Latest-generation flagship model', '["Reasoning", "Coding", "Multimodal"]', '{"type":"llm","streaming":true}', 1, true),
      ('gpt-5.2-chat-latest', 'openai', 'GPT-5.2 Chat (Latest)', 'Optimized chat alias', '["Chat", "Fast iteration"]', '{"type":"llm","streaming":true}', 2, true),
      ('gpt-5.2-pro', 'openai', 'GPT-5.2 Pro', 'Higher capability tier', '["Complex reasoning", "Tool use"]', '{"type":"llm","streaming":true}', 3, true),
      ('text-embedding-3-small', 'openai', 'Text Embedding 3 Small', 'Efficient embeddings', '["Search", "Clustering"]', '{"type":"embedding","defaultDimension":1536}', 4, true),
      ('text-embedding-3-large', 'openai', 'Text Embedding 3 Large', 'High-precision embeddings', '["Semantic search", "Knowledge retrieval"]', '{"type":"embedding","defaultDimension":3072}', 5, true),
      ('claude-sonnet-4-5', 'anthropic', 'Claude Sonnet 4.5', 'Advanced reasoning', '["Analysis", "Coding", "Writing"]', '{"type":"llm","streaming":true}', 1, true),
      ('claude-haiku-4-5', 'anthropic', 'Claude Haiku 4.5', 'Fastest Claude model', '["Quick responses", "Data extraction"]', '{"type":"llm","streaming":true}', 2, true),
      ('claude-opus-4-5', 'anthropic', 'Claude Opus 4.5', 'Highest quality Claude model', '["Deep research", "Complex tasks"]', '{"type":"llm","streaming":true}', 3, true),
      ('gemini-3-flash-preview', 'google', 'Gemini 3 Flash (Preview)', 'Low-latency preview model', '["Realtime apps", "High volume"]', '{"type":"llm","streaming":true}', 1, true),
      ('gemini-3-pro-preview', 'google', 'Gemini 3 Pro (Preview)', 'Advanced reasoning preview', '["Complex tasks", "Analysis"]', '{"type":"llm","streaming":true}', 2, true),
      ('gemini-embedding-001', 'google', 'Gemini Embedding 001', 'Configurable embeddings', '["General purpose", "Retrieval"]', '{"type":"embedding","defaultDimension":3072}', 3, true),
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
      is_enabled = models.is_enabled;
  `,
  name: 'update_provider_models_2026_frontier',
  up: `
    -- Remove superseded model IDs
    DELETE FROM models WHERE id IN (
      'gpt-5.2-chat-latest',
      'claude-sonnet-4-5',
      'claude-opus-4-5',
      'gemini-3-flash-preview',
      'gemini-3-pro-preview',
      'anthropic/claude-sonnet-4.5',
      'google/gemini-3-flash-preview'
    );

    -- OpenAI (GPT-5.5 / 5.4 / 5.3-codex / 5.2 + embeddings)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gpt-5.5', 'openai', 'GPT-5.5', 'Newest flagship for complex work', '["Reasoning", "Coding", "Agentic"]', '{"type":"llm","streaming":true}', 1, true),
      ('gpt-5.5-pro', 'openai', 'GPT-5.5 Pro', 'Highest capability tier', '["Complex reasoning", "Tool use"]', '{"type":"llm","streaming":true}', 2, true),
      ('gpt-5.4', 'openai', 'GPT-5.4', 'Balanced cost-aware flagship', '["Reasoning", "Coding", "Multimodal"]', '{"type":"llm","streaming":true}', 3, true),
      ('gpt-5.4-pro', 'openai', 'GPT-5.4 Pro', 'Higher capability tier', '["Complex reasoning", "Tool use"]', '{"type":"llm","streaming":true}', 4, true),
      ('gpt-5.4-mini', 'openai', 'GPT-5.4 Mini', 'Lower latency, lower cost', '["Chat", "High volume"]', '{"type":"llm","streaming":true}', 5, true),
      ('gpt-5.4-nano', 'openai', 'GPT-5.4 Nano', 'Smallest, fastest tier', '["Lightweight", "Classification"]', '{"type":"llm","streaming":true}', 6, true),
      ('gpt-5.3-codex', 'openai', 'GPT-5.3 Codex', 'Agentic coding model', '["Coding", "Agentic"]', '{"type":"llm","streaming":true}', 7, true),
      ('gpt-5.2', 'openai', 'GPT-5.2', 'Previous-generation flagship', '["Reasoning", "Coding"]', '{"type":"llm","streaming":true}', 8, true),
      ('gpt-5.2-pro', 'openai', 'GPT-5.2 Pro', 'Previous higher tier', '["Complex reasoning"]', '{"type":"llm","streaming":true}', 9, true),
      ('text-embedding-3-small', 'openai', 'Text Embedding 3 Small', 'Efficient embeddings', '["Search", "Clustering"]', '{"type":"embedding","defaultDimension":1536}', 10, true),
      ('text-embedding-3-large', 'openai', 'Text Embedding 3 Large', 'High-precision embeddings', '["Semantic search", "Knowledge retrieval"]', '{"type":"embedding","defaultDimension":3072}', 11, true)
    ON CONFLICT (id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id,
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      best_for = EXCLUDED.best_for,
      capabilities = EXCLUDED.capabilities,
      sort_order = EXCLUDED.sort_order,
      is_enabled = models.is_enabled;

    -- Anthropic (Opus 4.8 / Sonnet 4.6 / Haiku 4.5)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('claude-opus-4-8', 'anthropic', 'Claude Opus 4.8', 'Most capable Claude model', '["Deep research", "Agentic coding"]', '{"type":"llm","streaming":true}', 1, true),
      ('claude-sonnet-4-6', 'anthropic', 'Claude Sonnet 4.6', 'Best balance of speed and intelligence', '["Analysis", "Coding", "Writing"]', '{"type":"llm","streaming":true}', 2, true),
      ('claude-haiku-4-5', 'anthropic', 'Claude Haiku 4.5', 'Fastest Claude model', '["Quick responses", "Data extraction"]', '{"type":"llm","streaming":true}', 3, true)
    ON CONFLICT (id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id,
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      best_for = EXCLUDED.best_for,
      capabilities = EXCLUDED.capabilities,
      sort_order = EXCLUDED.sort_order,
      is_enabled = models.is_enabled;

    -- Google (Gemini 3.5 / 3.1 + 2.5 stable line + embeddings)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gemini-3.5-flash', 'google', 'Gemini 3.5 Flash', 'Stable low-latency flagship flash', '["Realtime apps", "High volume"]', '{"type":"llm","streaming":true}', 1, true),
      ('gemini-3.1-pro-preview', 'google', 'Gemini 3.1 Pro (Preview)', 'Advanced reasoning preview', '["Complex tasks", "Analysis"]', '{"type":"llm","streaming":true}', 2, true),
      ('gemini-3.1-flash-lite', 'google', 'Gemini 3.1 Flash Lite', 'Lightweight low-cost flash', '["Lightweight", "High volume"]', '{"type":"llm","streaming":true}', 3, true),
      ('gemini-2.5-pro', 'google', 'Gemini 2.5 Pro', 'Stable advanced reasoning', '["Complex tasks", "Analysis"]', '{"type":"llm","streaming":true}', 4, true),
      ('gemini-2.5-flash', 'google', 'Gemini 2.5 Flash', 'Stable fast model', '["Realtime apps", "High volume"]', '{"type":"llm","streaming":true}', 5, true),
      ('gemini-2.5-flash-lite', 'google', 'Gemini 2.5 Flash Lite', 'Stable lightweight flash', '["Lightweight", "High volume"]', '{"type":"llm","streaming":true}', 6, true),
      ('gemini-embedding-001', 'google', 'Gemini Embedding 001', 'Configurable embeddings', '["General purpose", "Retrieval"]', '{"type":"embedding","defaultDimension":3072}', 7, true),
      ('gemini-embedding-2', 'google', 'Gemini Embedding 2', 'Auto-normalizing configurable embeddings', '["General purpose", "Retrieval"]', '{"type":"embedding","defaultDimension":3072}', 8, true)
    ON CONFLICT (id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id,
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      best_for = EXCLUDED.best_for,
      capabilities = EXCLUDED.capabilities,
      sort_order = EXCLUDED.sort_order,
      is_enabled = models.is_enabled;

    -- OpenRouter (gateway, provider-prefixed slugs; default disabled like prior catalog)
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('openai/gpt-5.5', 'openrouter', 'GPT-5.5 (OpenRouter)', 'Newest OpenAI flagship', '["Reasoning", "Coding"]', '{"type":"llm","streaming":true}', 1, false),
      ('openai/gpt-5.4', 'openrouter', 'GPT-5.4 (OpenRouter)', 'Balanced OpenAI flagship', '["Reasoning", "Coding"]', '{"type":"llm","streaming":true}', 2, false),
      ('openai/gpt-5.4-mini', 'openrouter', 'GPT-5.4 Mini (OpenRouter)', 'Lower-cost OpenAI model', '["Chat", "High volume"]', '{"type":"llm","streaming":true}', 3, false),
      ('openai/gpt-5.3-codex', 'openrouter', 'GPT-5.3 Codex (OpenRouter)', 'Agentic coding model', '["Coding", "Agentic"]', '{"type":"llm","streaming":true}', 4, false),
      ('openai/gpt-5.2', 'openrouter', 'GPT-5.2 (OpenRouter)', 'Previous OpenAI flagship', '["Reasoning", "Coding"]', '{"type":"llm","streaming":true}', 5, false),
      ('anthropic/claude-opus-4.8', 'openrouter', 'Claude Opus 4.8 (OpenRouter)', 'Most capable Claude', '["Deep research"]', '{"type":"llm","streaming":true}', 6, false),
      ('anthropic/claude-sonnet-4.6', 'openrouter', 'Claude Sonnet 4.6 (OpenRouter)', 'Balanced Claude model', '["Analysis", "Writing"]', '{"type":"llm","streaming":true}', 7, false),
      ('anthropic/claude-haiku-4.5', 'openrouter', 'Claude Haiku 4.5 (OpenRouter)', 'Fastest Claude model', '["Quick responses"]', '{"type":"llm","streaming":true}', 8, false),
      ('google/gemini-3.5-flash', 'openrouter', 'Gemini 3.5 Flash (OpenRouter)', 'Stable low-latency Gemini', '["Realtime apps"]', '{"type":"llm","streaming":true}', 9, false),
      ('google/gemini-3.1-pro-preview', 'openrouter', 'Gemini 3.1 Pro (OpenRouter)', 'Advanced Gemini preview', '["Complex tasks"]', '{"type":"llm","streaming":true}', 10, false),
      ('google/gemini-2.5-flash', 'openrouter', 'Gemini 2.5 Flash (OpenRouter)', 'Stable fast Gemini', '["Realtime apps"]', '{"type":"llm","streaming":true}', 11, false)
    ON CONFLICT (id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id,
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      best_for = EXCLUDED.best_for,
      capabilities = EXCLUDED.capabilities,
      sort_order = EXCLUDED.sort_order,
      is_enabled = models.is_enabled;
  `,
  version: 33,
};
