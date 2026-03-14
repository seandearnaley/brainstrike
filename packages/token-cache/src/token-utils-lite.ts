/**
 * Minimal token counting helpers for worker use (no pino/logger dependency).
 *
 * This module must stay free of direct tiktoken imports so heuristic-only worker
 * startup cannot trigger late Vite dependency optimization and full-app reloads.
 * Accurate counting is isolated behind a lazy import in token-utils-accurate-lite.
 */

let accurateTokenUtilsPromise: Promise<typeof import('./token-utils-accurate-lite')> | null = null;
let lastAccurateFailureReason: string | null = null;

export function countTokensHeuristic(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

function getAccurateTokenUtils(): Promise<typeof import('./token-utils-accurate-lite')> {
  if (!accurateTokenUtilsPromise) {
    accurateTokenUtilsPromise = import('./token-utils-accurate-lite').catch((error: unknown) => {
      accurateTokenUtilsPromise = null;
      throw error;
    });
  }
  return accurateTokenUtilsPromise;
}

export function getAccurateTokenCountingFailureReason(): string | null {
  return lastAccurateFailureReason;
}

export async function supportsAccurateTokenCounting(): Promise<boolean> {
  const accurateTokenUtils = await getAccurateTokenUtils();
  const supported = await accurateTokenUtils.supportsAccurateTokenCounting();
  lastAccurateFailureReason = accurateTokenUtils.getAccurateTokenCountingFailureReason();
  return supported;
}

export async function countTokensAccurate(text: string): Promise<number> {
  const accurateTokenUtils = await getAccurateTokenUtils();
  try {
    return await accurateTokenUtils.countTokensAccurate(text);
  } finally {
    lastAccurateFailureReason = accurateTokenUtils.getAccurateTokenCountingFailureReason();
  }
}
