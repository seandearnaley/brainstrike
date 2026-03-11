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

export async function supportsAccurateTokenCounting(): Promise<boolean> {
  const tokenUtils = await loadTokenUtilsModule();
  return tokenUtils.supportsAccurateTokenCounting();
}

export async function countTokensAccurate(text: string): Promise<number> {
  const tokenUtils = await loadTokenUtilsModule();
  return tokenUtils.countTokensAccurate(text);
}

export function __resetTokenCountingRuntimeModuleForTests(): void {
  tokenUtilsModulePromise = null;
}
