/**
 * OpenCode's coding-oriented output ceiling. OpenRouter models with a smaller
 * advertised completion limit use that limit instead.
 */
export const OPENROUTER_CODING_MAX_OUTPUT_TOKENS = 32_000;

export function resolveOpenRouterCodingMaxOutputTokens(modelMaxOutputTokens?: number): number {
  if (modelMaxOutputTokens === undefined) {
    return OPENROUTER_CODING_MAX_OUTPUT_TOKENS;
  }
  if (!(Number.isSafeInteger(modelMaxOutputTokens) && modelMaxOutputTokens > 0)) {
    throw new Error(`modelMaxOutputTokens must be a positive integer, got ${modelMaxOutputTokens}`);
  }
  return Math.min(modelMaxOutputTokens, OPENROUTER_CODING_MAX_OUTPUT_TOKENS);
}
