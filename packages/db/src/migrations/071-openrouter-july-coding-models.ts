import type { Migration } from './migration-runner';

/** Add Curator's July 2026 coding-model findings to the persisted model picker. */
export const migration071OpenRouterJulyCodingModels: Migration = {
  down: `
    DELETE FROM models
    WHERE provider_id = 'openrouter'
      AND id IN (
        'poolside/laguna-s-2.1',
        'poolside/laguna-xs-2.1',
        'google/gemini-3.6-flash',
        'google/gemini-3.5-flash-lite',
        'meituan/longcat-2.0',
        'thinkingmachines/inkling',
        'kwaipilot/kat-coder-air-v2.5',
        'kwaipilot/kat-coder-pro-v2.5',
        'x-ai/grok-4.5'
      );
    UPDATE models SET sort_order = sort_order - 9 WHERE provider_id = 'openrouter';
  `,
  ledgerKey: 'custom-071-openrouter-july-coding-models',
  name: 'openrouter_july_coding_models',
  up: `
    UPDATE models SET sort_order = sort_order + 9 WHERE provider_id = 'openrouter';
    INSERT INTO models
      (id, provider_id, name, tagline, best_for, capabilities, sort_order, is_enabled)
    VALUES
      (
        'poolside/laguna-s-2.1',
        'openrouter',
        'Laguna S 2.1 (OpenRouter)',
        'Million-token coding agent from Poolside',
        '["Repository-scale coding", "Terminal workflows", "Tool use"]',
        '{"type":"llm","streaming":true,"vision":false}',
        1,
        false
      ),
      (
        'poolside/laguna-xs-2.1',
        'openrouter',
        'Laguna XS 2.1 (OpenRouter)',
        'Efficient coding agent from Poolside',
        '["Coding", "Fast iteration", "Tool use"]',
        '{"type":"llm","streaming":true,"vision":false}',
        2,
        false
      ),
      (
        'google/gemini-3.6-flash',
        'openrouter',
        'Gemini 3.6 Flash (OpenRouter)',
        'High-efficiency coding and agentic model',
        '["Coding", "Agentic workflows", "Multimodal development"]',
        '{"type":"llm","streaming":true,"vision":true}',
        3,
        false
      ),
      (
        'google/gemini-3.5-flash-lite',
        'openrouter',
        'Gemini 3.5 Flash Lite (OpenRouter)',
        'Efficient model for focused agent tasks',
        '["Subagents", "Focused coding tasks", "High-volume workflows"]',
        '{"type":"llm","streaming":true,"vision":true}',
        4,
        false
      ),
      (
        'meituan/longcat-2.0',
        'openrouter',
        'LongCat 2.0 (OpenRouter)',
        'Long-context repository coding model',
        '["Repository changes", "Long-horizon coding", "Tool use"]',
        '{"type":"llm","streaming":true,"vision":false}',
        5,
        false
      ),
      (
        'thinkingmachines/inkling',
        'openrouter',
        'Inkling (OpenRouter)',
        'Multimodal reasoning for agent systems',
        '["Coding", "Agentic workflows", "Tool use"]',
        '{"type":"llm","streaming":true,"vision":true}',
        6,
        false
      ),
      (
        'kwaipilot/kat-coder-air-v2.5',
        'openrouter',
        'KAT-Coder Air V2.5 (OpenRouter)',
        'Efficient autonomous coding model',
        '["Issue resolution", "Repository editing", "Tool use"]',
        '{"type":"llm","streaming":true,"vision":false}',
        7,
        false
      ),
      (
        'kwaipilot/kat-coder-pro-v2.5',
        'openrouter',
        'KAT-Coder Pro V2.5 (OpenRouter)',
        'Flagship autonomous coding model',
        '["Issue resolution", "Repository editing", "Tool use"]',
        '{"type":"llm","streaming":true,"vision":false}',
        8,
        false
      ),
      (
        'x-ai/grok-4.5',
        'openrouter',
        'Grok 4.5 (OpenRouter)',
        'Frontier coding and knowledge-work model',
        '["Coding", "Knowledge work", "Reasoning"]',
        '{"type":"llm","streaming":true,"vision":true}',
        9,
        false
      )
    ON CONFLICT (id) DO UPDATE SET
      provider_id = EXCLUDED.provider_id,
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      best_for = EXCLUDED.best_for,
      capabilities = EXCLUDED.capabilities,
      sort_order = EXCLUDED.sort_order,
      is_enabled = models.is_enabled;
  `,
  version: 71,
};
