/**
 * Token Cache Worker
 *
 * Background Web Worker for non-blocking token counting.
 * Uses workerpool for easy integration with main thread.
 */

/// <reference lib="webworker" />

import { worker, workerEmit } from 'workerpool';
import type { TokenCountRequest, TokenCountResult } from './types';

interface XXHashModule {
  h64: (input: string) => bigint;
  create64: () => {
    update: (input: string) => void;
    digest: () => bigint;
  };
}

/**
 * Convert bigint hash to hex string
 */
function hashToHex(hash: bigint): string {
  return hash.toString(16).padStart(16, '0');
}

let hasherInstance: XXHashModule | null = null;
let tokenUtilsPromise: Promise<{
  countTokensAccurate: (text: string) => Promise<number>;
  countTokensHeuristic: (text: string) => number;
}> | null = null;

/**
 * Initialize xxHash WASM
 */
async function initHasher(): Promise<XXHashModule> {
  if (hasherInstance) {
    return hasherInstance;
  }

  const xxhashModule = await import('xxhash-wasm');
  // Handle both ESM default export and CJS module.exports
  const xxhashFn = typeof xxhashModule.default === 'function' ? xxhashModule.default : xxhashModule;
  hasherInstance = (await (xxhashFn as () => Promise<XXHashModule>)()) as XXHashModule;
  return hasherInstance;
}

/**
 * Lazy load token counting utilities (using lite version without pino)
 */
async function getTokenUtils(): Promise<{
  countTokensAccurate: (text: string) => Promise<number>;
  countTokensHeuristic: (text: string) => number;
}> {
  if (!tokenUtilsPromise) {
    tokenUtilsPromise = import('./token-utils-lite').then((mod) => ({
      countTokensAccurate: mod.countTokensAccurate,
      countTokensHeuristic: mod.countTokensHeuristic,
    }));
  }
  return tokenUtilsPromise;
}

/**
 * Count tokens for a single file
 */
async function countTokens(request: TokenCountRequest): Promise<TokenCountResult> {
  let hasher: XXHashModule;
  let utils: Awaited<ReturnType<typeof getTokenUtils>>;

  try {
    [hasher, utils] = await Promise.all([initHasher(), getTokenUtils()]);
  } catch (initError) {
    // Re-throw with more context for debugging
    const message = initError instanceof Error ? initError.message : String(initError);
    throw new Error(`Token worker initialization failed: ${message}`);
  }

  // Hash content for cache key
  const contentHash = hashToHex(hasher.h64(request.content));

  // Count tokens based on mode
  const tokenCount =
    request.mode === 'accurate'
      ? await utils.countTokensAccurate(request.content)
      : utils.countTokensHeuristic(request.content);

  return {
    id: request.id,
    tokenCount,
    contentHash,
    mode: request.mode,
  };
}

/**
 * Count tokens for multiple files in batch.
 * Emits progress events for UI updates.
 */
async function countTokensBatch(requests: TokenCountRequest[]): Promise<TokenCountResult[]> {
  if (requests.length === 0) {
    return [];
  }

  // Pre-initialize to avoid repeated async overhead
  const [hasher, utils] = await Promise.all([initHasher(), getTokenUtils()]);

  const results: TokenCountResult[] = [];
  const total = requests.length;

  for (const [i, request] of requests.entries()) {
    // Hash content
    const contentHash = hashToHex(hasher.h64(request.content));

    // Count tokens
    const tokenCount =
      request.mode === 'accurate'
        ? await utils.countTokensAccurate(request.content)
        : utils.countTokensHeuristic(request.content);

    const result: TokenCountResult = {
      id: request.id,
      tokenCount,
      contentHash,
      mode: request.mode,
    };

    results.push(result);

    // Emit progress every item (or could batch for efficiency)
    workerEmit({
      type: 'progress',
      completed: i + 1,
      total,
      currentId: request.id,
    });

    // Yield to event loop periodically to prevent blocking
    if (i % 10 === 0 && i > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return results;
}

/**
 * Hash content without counting tokens.
 * Useful for cache validation.
 */
async function hashContent(content: string): Promise<string> {
  const hasher = await initHasher();
  return hashToHex(hasher.h64(content));
}

/**
 * Hash multiple contents in batch.
 */
async function hashContentBatch(
  contents: Array<{ id: string; content: string }>
): Promise<Array<{ id: string; hash: string }>> {
  const hasher = await initHasher();
  return contents.map(({ id, content }) => ({
    id,
    hash: hashToHex(hasher.h64(content)),
  }));
}

// Export worker methods
worker({
  countTokens,
  countTokensBatch,
  hashContent,
  hashContentBatch,
});
