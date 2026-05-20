/**
 * Lightweight token-counting runtime facade for visible-renderer consumers.
 *
 * The accurate tokenizer path lives in ./token-utils and pulls in the WASM-backed
 * tiktoken runtime. Lightweight heuristics stay inside utils so UI code does not
 * depend on indexing-owned chunking packages.
 * Keep this facade small so UI code can defer the accurate tokenizer cost until
 * the user explicitly enables accurate counting or requests a token count.
 */

import {
  countTokensHeuristic,
  estimateTokenCost,
  formatTokenCount,
} from './token-counting-heuristics';

export { countTokensHeuristic, estimateTokenCost, formatTokenCount };

type TokenUtilsModule = typeof import('./token-utils');

let tokenUtilsModulePromise: Promise<TokenUtilsModule> | null = null;

function loadTokenUtilsModule(): Promise<TokenUtilsModule> {
  if (!tokenUtilsModulePromise) {
    tokenUtilsModulePromise = import('./token-utils');
  }
  return tokenUtilsModulePromise;
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
