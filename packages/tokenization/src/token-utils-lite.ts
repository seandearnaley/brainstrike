/**
 * Minimal token counting helpers for worker bundles.
 *
 * This module must stay free of direct tiktoken imports so loading the worker for
 * non-token strategies cannot trigger late Vite dependency optimization and app
 * reloads in development. Accurate counting is isolated in token-utils-accurate-lite.
 *
 * Both worker packages bundle this one source into their own isolated output;
 * neither worker imports the other worker's graph at runtime.
 */

export { countTokensHeuristic } from './token-counting-heuristics.ts';

let accurateTokenUtilsPromise: Promise<typeof import('./token-utils-accurate-lite.ts')> | null =
  null;
let lastAccurateFailureReason: string | null = null;

function getAccurateTokenUtils(): Promise<typeof import('./token-utils-accurate-lite.ts')> {
  if (!accurateTokenUtilsPromise) {
    accurateTokenUtilsPromise = import('./token-utils-accurate-lite.ts').catch((error: unknown) => {
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

export async function getAccurateTokenCounter(): Promise<
  import('./token-utils-accurate-lite.ts').SyncAccurateCounter | null
> {
  const accurateTokenUtils = await getAccurateTokenUtils();
  try {
    return await accurateTokenUtils.getAccurateTokenCounter();
  } finally {
    lastAccurateFailureReason = accurateTokenUtils.getAccurateTokenCountingFailureReason();
  }
}

export async function disposeAccurateTokenCountingRuntime(): Promise<void> {
  if (!accurateTokenUtilsPromise) {
    return;
  }
  const accurateTokenUtils = await accurateTokenUtilsPromise;
  accurateTokenUtils.disposeAccurateTokenCountingRuntime();
  accurateTokenUtilsPromise = null;
  lastAccurateFailureReason = null;
}
