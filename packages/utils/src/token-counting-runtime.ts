/**
 * Lightweight token-counting runtime facade for visible-renderer consumers.
 *
 * The accurate tokenizer path lives in ./token-utils and pulls in the WASM-backed
 * tiktoken runtime. Keep this facade small so UI code can defer that cost until
 * the user explicitly enables accurate counting or requests a token count.
 */

type TokenUtilsModule = typeof import('./token-utils');

let tokenUtilsModulePromise: Promise<TokenUtilsModule> | null = null;

function loadTokenUtilsModule(): Promise<TokenUtilsModule> {
  if (!tokenUtilsModulePromise) {
    tokenUtilsModulePromise = import('./token-utils');
  }
  return tokenUtilsModulePromise;
}

export function countTokensHeuristic(text: string): number {
  const chars = text.length;
  return Math.ceil(chars / 4);
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
  const inputCost = inputTokens * 0.000_01;
  const outputCost = outputTokens * 0.000_03;
  return inputCost + outputCost;
}

export async function supportsAccurateTokenCounting(): Promise<boolean> {
  const tokenUtils = await loadTokenUtilsModule();
  return tokenUtils.supportsAccurateTokenCounting();
}

export const supportsAccurateTokenCountingLazy = supportsAccurateTokenCounting;

export async function countTokensAccurate(text: string): Promise<number> {
  const tokenUtils = await loadTokenUtilsModule();
  return tokenUtils.countTokensAccurate(text);
}

export const countTokensAccurateLazy = countTokensAccurate;

export const countTokensHeuristicLazy = countTokensHeuristic;

export async function calculateGroupTokens(texts: string[]): Promise<number> {
  const tokenUtils = await loadTokenUtilsModule();
  return tokenUtils.calculateGroupTokens(texts);
}

export function __resetTokenCountingRuntimeModuleForTests(): void {
  tokenUtilsModulePromise = null;
}
