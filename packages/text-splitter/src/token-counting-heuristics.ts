export function countTokensHeuristic(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

export function formatTokenCount(count: number): string {
  if (count < 1000) {
    return `${count} tokens`;
  }

  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(1)}K tokens`;
  }

  return `${(count / 1_000_000).toFixed(1)}M tokens`;
}

export function estimateTokenCost(inputTokens: number, outputTokens = 0): number {
  // UI heuristic only. Update intentionally alongside model pricing.
  const inputCost = inputTokens * 0.000_01;
  const outputCost = outputTokens * 0.000_03;
  return inputCost + outputCost;
}
