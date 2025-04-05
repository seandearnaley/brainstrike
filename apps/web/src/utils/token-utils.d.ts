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
export declare function countTokensAccurate(text: string): number;
/**
 * Estimate token count using the character heuristic (1 token ≈ 4 chars)
 * This is less accurate but much faster for very large inputs
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated number of tokens in the text
 */
export declare function countTokensHeuristic(text: string): number;
/**
 * Format a token count for display
 *
 * @param count - The token count to format
 * @returns A formatted string (e.g., "1.2K tokens")
 */
export declare function formatTokenCount(count: number): string;
/**
 * Calculate token count for a group of texts
 *
 * @param texts - Array of text strings
 * @param useHeuristic - Whether to use the faster heuristic method
 * @returns Total token count for all texts
 */
export declare function calculateGroupTokens(texts: string[], useHeuristic?: boolean): number;
/**
 * Estimate the cost of tokens at standard OpenAI GPT-4 rates
 * This is just an estimate and actual costs may vary
 *
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens (optional)
 * @returns Estimated cost in USD
 */
export declare function estimateTokenCost(inputTokens: number, outputTokens?: number): number;
//# sourceMappingURL=token-utils.d.ts.map