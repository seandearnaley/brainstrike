/**
 * Token Cache Worker
 *
 * Background Web Worker for non-blocking token counting.
 * Uses direct postMessage RPC so Electron/browser bundlers own worker startup.
 */

/// <reference lib="webworker" />

import { countTokensForMode } from './token-counting-runtime';
import type {
  TokenCountRequest,
  TokenCountResult,
  TokenWorkerRequest,
  TokenWorkerResponse,
  TokenWorkerResponseError,
} from './types';

interface XXHashModule {
  create64: () => {
    update: (input: string) => void;
    digest: () => bigint;
  };
  h64: (input: string) => bigint;
}

/**
 * Convert bigint hash to hex string
 */
function hashToHex(hash: bigint): string {
  return hash.toString(16).padStart(16, '0');
}

let hasherInstance: XXHashModule | null = null;
let tokenUtilsPromise: Promise<{
  supportsAccurateTokenCounting: () => Promise<boolean>;
  getAccurateTokenCountingFailureReason: () => string | null;
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
  supportsAccurateTokenCounting: () => Promise<boolean>;
  getAccurateTokenCountingFailureReason: () => string | null;
  countTokensAccurate: (text: string) => Promise<number>;
  countTokensHeuristic: (text: string) => number;
}> {
  if (!tokenUtilsPromise) {
    tokenUtilsPromise = import('./token-utils-lite').then((mod) => ({
      countTokensAccurate: mod.countTokensAccurate,
      countTokensHeuristic: mod.countTokensHeuristic,
      getAccurateTokenCountingFailureReason: mod.getAccurateTokenCountingFailureReason,
      supportsAccurateTokenCounting: mod.supportsAccurateTokenCounting,
    }));
  }
  return tokenUtilsPromise;
}

/**
 * Count tokens for a single file
 */
async function countTokens(request: TokenCountRequest): Promise<TokenCountResult> {
  let hasher: XXHashModule;

  try {
    hasher = await initHasher();
  } catch (initError) {
    // Re-throw with more context for debugging
    const message = initError instanceof Error ? initError.message : String(initError);
    throw new Error(`Token worker initialization failed: ${message}`);
  }

  // Hash content for cache key
  const contentHash = hashToHex(hasher.h64(request.content));

  // Count tokens based on mode
  const tokenCount = await countTokensForMode(request.mode, request.content, getTokenUtils);

  return {
    contentHash,
    id: request.id,
    mode: request.mode,
    tokenCount,
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
  const hasher = await initHasher();

  const results: TokenCountResult[] = [];
  const total = requests.length;

  for (const [i, request] of requests.entries()) {
    // Hash content
    const contentHash = hashToHex(hasher.h64(request.content));

    // Count tokens
    const tokenCount = await countTokensForMode(request.mode, request.content, getTokenUtils);

    const result: TokenCountResult = {
      contentHash,
      id: request.id,
      mode: request.mode,
      tokenCount,
    };

    results.push(result);

    self.postMessage({
      completed: i + 1,
      currentId: request.id,
      total,
      type: 'progress',
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
    hash: hashToHex(hasher.h64(content)),
    id,
  }));
}

const workerMethods = {
  countTokens,
  countTokensBatch,
  hashContent,
  hashContentBatch,
};

async function executeRequestMethod(
  method: TokenWorkerRequest['method'],
  params: unknown[]
): Promise<unknown> {
  switch (method) {
    case 'countTokens':
      return workerMethods.countTokens(params[0] as TokenCountRequest);
    case 'countTokensBatch':
      return workerMethods.countTokensBatch(params[0] as TokenCountRequest[]);
    case 'hashContent':
      return workerMethods.hashContent(params[0] as string);
    case 'hashContentBatch':
      return workerMethods.hashContentBatch(params[0] as Array<{ id: string; content: string }>);
  }
}

function isTokenWorkerRequest(value: unknown): value is TokenWorkerRequest {
  if (!(typeof value === 'object' && value !== null)) {
    return false;
  }

  const candidate = value as Partial<TokenWorkerRequest>;
  return (
    candidate.type === 'request' &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.method === 'string' &&
    Array.isArray(candidate.params)
  );
}

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!isTokenWorkerRequest(event.data)) {
    return;
  }

  const request = event.data;

  void (async () => {
    const { method, params, requestId } = request;

    try {
      const result = await executeRequestMethod(method, params);
      const response: TokenWorkerResponse = {
        requestId,
        result,
        type: 'response',
      };
      self.postMessage(response);
    } catch (error) {
      const response: TokenWorkerResponseError = {
        message: error instanceof Error ? error.message : String(error),
        requestId,
        type: 'error',
      };
      if (error instanceof Error && error.stack) {
        response.cause = error.stack;
      }
      self.postMessage(response);
    }
  })();
});
