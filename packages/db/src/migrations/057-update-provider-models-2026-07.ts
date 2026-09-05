import type { Migration } from './migration-runner';

/** Refresh the persisted picker catalog to match the July 2026 static registry. */
export const migration057UpdateProviderModels202607: Migration = {
  down: `
    DELETE FROM models WHERE id IN (
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
      'claude-fable-5', 'claude-sonnet-5',
      'openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna',
      'anthropic/claude-fable-5', 'anthropic/claude-sonnet-5',
      'z-ai/glm-5.2', 'minimax/minimax-m3',
      'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash',
      'qwen/qwen3.7-max', 'qwen/qwen3.7-plus', 'qwen/qwen3.6-flash',
      'qwen/qwen3-coder-next', 'moonshotai/kimi-k2.6', 'moonshotai/kimi-k2.7-code'
    );
    UPDATE models SET sort_order = sort_order - 3 WHERE provider_id = 'openai';
    UPDATE models SET sort_order = CASE id
      WHEN 'claude-opus-4-8' THEN 1
      WHEN 'claude-sonnet-4-6' THEN 2
      WHEN 'claude-haiku-4-5' THEN 3
      ELSE sort_order
    END WHERE provider_id = 'anthropic';
    UPDATE models SET sort_order = sort_order - 15 WHERE provider_id = 'openrouter';
  `,
  ledgerKey: 'custom-057-update-provider-models-2026-07',
  name: 'update_provider_models_2026_07',
  up: `
    UPDATE models SET sort_order = sort_order + 3 WHERE provider_id = 'openai';
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('gpt-5.6-sol', 'openai', 'GPT-5.6 Sol', 'Highest-capability GPT-5.6 tier', '["Deep reasoning", "Agentic work"]', '{"type":"llm","streaming":true}', 1, true),
      ('gpt-5.6-terra', 'openai', 'GPT-5.6 Terra', 'Balanced GPT-5.6 tier', '["Reasoning", "Coding", "Tool use"]', '{"type":"llm","streaming":true}', 2, true),
      ('gpt-5.6-luna', 'openai', 'GPT-5.6 Luna', 'Efficient GPT-5.6 tier', '["High volume", "Fast iteration"]', '{"type":"llm","streaming":true}', 3, true)
    ON CONFLICT (id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id, name = EXCLUDED.name, tagline = EXCLUDED.tagline,
      best_for = EXCLUDED.best_for, capabilities = EXCLUDED.capabilities,
      sort_order = EXCLUDED.sort_order, is_enabled = models.is_enabled;

    UPDATE models SET sort_order = CASE id
      WHEN 'claude-opus-4-8' THEN 2
      WHEN 'claude-sonnet-4-6' THEN 4
      WHEN 'claude-haiku-4-5' THEN 5
      ELSE sort_order
    END WHERE provider_id = 'anthropic';
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('claude-fable-5', 'anthropic', 'Claude Fable 5', 'Highest-capability Claude 5 tier', '["Deep research", "Complex agents"]', '{"type":"llm","streaming":true}', 1, true),
      ('claude-sonnet-5', 'anthropic', 'Claude Sonnet 5', 'Balanced Claude 5 model', '["Analysis", "Coding", "Writing"]', '{"type":"llm","streaming":true}', 3, true)
    ON CONFLICT (id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id, name = EXCLUDED.name, tagline = EXCLUDED.tagline,
      best_for = EXCLUDED.best_for, capabilities = EXCLUDED.capabilities,
      sort_order = EXCLUDED.sort_order, is_enabled = models.is_enabled;

    -- Gateway models retain the established default-disabled policy; users opt
    -- into the routes they want after enabling/configuring OpenRouter.
    UPDATE models SET sort_order = sort_order + 15 WHERE provider_id = 'openrouter';
    INSERT INTO models (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled) VALUES
      ('openai/gpt-5.6-sol', 'openrouter', 'GPT-5.6 Sol (OpenRouter)', 'Highest-capability GPT-5.6 route', '["Deep reasoning", "Agentic work"]', '{"type":"llm","streaming":true}', 1, false),
      ('openai/gpt-5.6-terra', 'openrouter', 'GPT-5.6 Terra (OpenRouter)', 'Balanced GPT-5.6 route', '["Reasoning", "Coding", "Tool use"]', '{"type":"llm","streaming":true}', 2, false),
      ('openai/gpt-5.6-luna', 'openrouter', 'GPT-5.6 Luna (OpenRouter)', 'Efficient GPT-5.6 route', '["High volume", "Fast iteration"]', '{"type":"llm","streaming":true}', 3, false),
      ('anthropic/claude-fable-5', 'openrouter', 'Claude Fable 5 (OpenRouter)', 'Highest-capability Claude 5 route', '["Deep research", "Complex agents"]', '{"type":"llm","streaming":true}', 4, false),
      ('anthropic/claude-sonnet-5', 'openrouter', 'Claude Sonnet 5 (OpenRouter)', 'Balanced Claude 5 route', '["Analysis", "Coding", "Writing"]', '{"type":"llm","streaming":true}', 5, false),
      ('z-ai/glm-5.2', 'openrouter', 'GLM-5.2 (OpenRouter)', 'Long-context agentic reasoning', '["Reasoning", "Coding", "Tool use"]', '{"type":"llm","streaming":true}', 6, false),
      ('minimax/minimax-m3', 'openrouter', 'MiniMax M3 (OpenRouter)', 'Long-context general model', '["Reasoning", "Agents", "Multilingual"]', '{"type":"llm","streaming":true}', 7, false),
      ('deepseek/deepseek-v4-pro', 'openrouter', 'DeepSeek V4 Pro (OpenRouter)', 'High-capability DeepSeek route', '["Reasoning", "Coding"]', '{"type":"llm","streaming":true}', 8, false),
      ('deepseek/deepseek-v4-flash', 'openrouter', 'DeepSeek V4 Flash (OpenRouter)', 'Fast efficient DeepSeek route', '["Fast iteration", "Coding"]', '{"type":"llm","streaming":true}', 9, false),
      ('qwen/qwen3.7-max', 'openrouter', 'Qwen3.7 Max (OpenRouter)', 'Flagship Qwen reasoning model', '["Reasoning", "Agents", "Multilingual"]', '{"type":"llm","streaming":true}', 10, false),
      ('qwen/qwen3.7-plus', 'openrouter', 'Qwen3.7 Plus (OpenRouter)', 'Balanced Qwen reasoning model', '["Reasoning", "Coding", "Tool use"]', '{"type":"llm","streaming":true}', 11, false),
      ('qwen/qwen3.6-flash', 'openrouter', 'Qwen3.6 Flash (OpenRouter)', 'Fast Qwen model', '["High volume", "Fast iteration"]', '{"type":"llm","streaming":true}', 12, false),
      ('qwen/qwen3-coder-next', 'openrouter', 'Qwen3 Coder Next (OpenRouter)', 'Qwen coding specialist', '["Coding", "Agentic development"]', '{"type":"llm","streaming":true}', 13, false),
      ('moonshotai/kimi-k2.6', 'openrouter', 'Kimi K2.6 (OpenRouter)', 'Long-context general model', '["Reasoning", "Agents", "Multilingual"]', '{"type":"llm","streaming":true}', 14, false),
      ('moonshotai/kimi-k2.7-code', 'openrouter', 'Kimi K2.7 Code (OpenRouter)', 'Kimi coding specialist', '["Coding", "Agentic development"]', '{"type":"llm","streaming":true}', 15, false)
    ON CONFLICT (id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id, name = EXCLUDED.name, tagline = EXCLUDED.tagline,
      best_for = EXCLUDED.best_for, capabilities = EXCLUDED.capabilities,
      sort_order = EXCLUDED.sort_order, is_enabled = models.is_enabled;
  `,
  version: 57,
};
