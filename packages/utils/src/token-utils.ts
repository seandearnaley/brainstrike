/**
 * Utility functions for estimating token counts for large language models
 */

/**
 * Accurately count tokens using OpenAI's tiktoken encoding
 * This provides exact counts for GPT-4 and a good approximation for Claude
 *
 * @param text - The text to count tokens for
 * @returns The number of tokens in the text
 */
export async function countTokensAccurate(text: string): Promise<number> {
  try {
    // We're dynamically importing to make this dependency optional
    // This allows using the package without the dependency if not needed
    const tokenizer = await import('gpt-tokenizer');
    return tokenizer.encode(text).length;
  } catch (_e) {
    // Fallback to heuristic method if the package is not available
    console.warn('gpt-tokenizer not available, using heuristic estimate instead');
    return countTokensHeuristic(text);
  }
}

/**
 * Estimate token count using the character heuristic (1 token ≈ 4 chars)
 * This is less accurate but much faster for very large inputs
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated number of tokens in the text
 */
export function countTokensHeuristic(text: string): number {
  const chars = text.length;
  // ~4 chars per token on average in English
  return Math.ceil(chars / 4);
}

/**
 * Format a token count for display
 *
 * @param count - The token count to format
 * @returns A formatted string (e.g., "1.2K tokens")
 */
export function formatTokenCount(count: number): string {
  if (count < 1000) {
    return `${count} tokens`;
  }

  if (count < 1000000) {
    return `${(count / 1000).toFixed(1)}K tokens`;
  }

  return `${(count / 1000000).toFixed(1)}M tokens`;
}

/**
 * Calculate token count for a group of texts
 *
 * @param texts - Array of text strings
 * @param useHeuristic - Whether to use the faster heuristic method
 * @returns Total token count for all texts
 */
export async function calculateGroupTokens(texts: string[], useHeuristic = false): Promise<number> {
  if (useHeuristic) {
    return texts.reduce((total, text) => total + countTokensHeuristic(text), 0);
  }

  let total = 0;
  for (const text of texts) {
    total += await countTokensAccurate(text);
  }
  return total;
}

/**
 * Estimate the cost of tokens at standard OpenAI GPT-4 rates
 * This is just an estimate and actual costs may vary
 *
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens (optional)
 * @returns Estimated cost in USD
 */
export function estimateTokenCost(inputTokens: number, outputTokens = 0): number {
  // Current GPT-4 rates as of March 2025: $10/1M input, $30/1M output tokens
  const inputCost = inputTokens * 0.00001; // $0.01 per 1K tokens
  const outputCost = outputTokens * 0.00003; // $0.03 per 1K tokens
  return inputCost + outputCost;
}
