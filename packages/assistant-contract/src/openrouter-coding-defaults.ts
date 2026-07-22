/**
 * OpenCode's coding-oriented output ceiling. OpenRouter models with a smaller
 * advertised completion limit use that limit instead.
 */
export const OPENROUTER_CODING_MAX_OUTPUT_TOKENS = 32_000;

/**
 * Small, deliberately diverse coding set enabled when a readable OpenRouter
 * configuration first meets an untouched model catalog. Each route is part of
 * the supported static registry and has passed a live assistant/tooling smoke.
 */
export const OPENROUTER_RECOMMENDED_CODING_MODEL_IDS = [
  'openai/gpt-5.6-terra',
  'moonshotai/kimi-k3',
  'qwen/qwen3.7-max',
] as const;

export function resolveOpenRouterCodingMaxOutputTokens(modelMaxOutputTokens?: number): number {
  if (modelMaxOutputTokens === undefined) {
    return OPENROUTER_CODING_MAX_OUTPUT_TOKENS;
  }
  if (!(Number.isSafeInteger(modelMaxOutputTokens) && modelMaxOutputTokens > 0)) {
    throw new Error(`modelMaxOutputTokens must be a positive integer, got ${modelMaxOutputTokens}`);
  }
  return Math.min(modelMaxOutputTokens, OPENROUTER_CODING_MAX_OUTPUT_TOKENS);
}
