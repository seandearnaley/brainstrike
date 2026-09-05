import type { Migration } from './migration-runner';

/**
 * Backfill the vision (image-input) capability onto every LLM catalog row.
 * Mirrors the static registry's `vision` declarations
 * (packages/assistant-contract/src/provider-registry.ts) — the two lists must
 * stay in sync; frontier-models-migration.test.ts asserts no LLM row is left
 * without a vision value, and the value-agreement test pins every row to
 * the registry declaration. Runs AFTER 060 (openrouter_spark_kimi_k3) so the
 * July 16 OpenRouter launches are patched too. Embedding rows are untouched
 * (vision is an LLM-only capability).
 */
export const migration061ModelVisionCapability: Migration = {
  down: `
    UPDATE models SET capabilities = capabilities - 'vision' WHERE capabilities ? 'vision';
  `,
  ledgerKey: 'custom-061-model-vision-capability',
  name: 'model_vision_capability',
  up: `
    UPDATE models SET capabilities = capabilities || '{"vision":true}'::jsonb
    WHERE capabilities->>'type' = 'llm' AND id IN (
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
      'gpt-5.5', 'gpt-5.5-pro',
      'gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.4-nano',
      'gpt-5.3-codex', 'gpt-5.2', 'gpt-5.2-pro',
      'claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5',
      'claude-sonnet-4-6', 'claude-haiku-4-5',
      'gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite',
      'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
      'openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna',
      'meta/muse-spark-1.1', 'moonshotai/kimi-k3',
      'anthropic/claude-fable-5', 'anthropic/claude-sonnet-5',
      'openai/gpt-5.5', 'openai/gpt-5.4', 'openai/gpt-5.4-mini',
      'openai/gpt-5.3-codex', 'openai/gpt-5.2',
      'anthropic/claude-opus-4.8', 'anthropic/claude-sonnet-4.6', 'anthropic/claude-haiku-4.5',
      'google/gemini-3.5-flash', 'google/gemini-3.1-pro-preview', 'google/gemini-2.5-flash'
    );

    -- Text-only models: vision ships as separate -V/-VL variants for these
    -- families, and the built-in Gemma runtime is a text-only pipeline.
    UPDATE models SET capabilities = capabilities || '{"vision":false}'::jsonb
    WHERE capabilities->>'type' = 'llm' AND id IN (
      'z-ai/glm-5.2', 'minimax/minimax-m3',
      'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash',
      'qwen/qwen3.7-max', 'qwen/qwen3.7-plus', 'qwen/qwen3.6-flash',
      'qwen/qwen3-coder-next', 'moonshotai/kimi-k2.6', 'moonshotai/kimi-k2.7-code',
      'onnx-community/gemma-4-E2B-it-ONNX'
    );
  `,
  version: 61,
};
