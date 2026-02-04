/**
 * Resolve the token cache worker URL that Vite/bundlers can turn into a `Worker` reference at runtime.
 * The `new URL(..., import.meta.url)` pattern is the MDN-recommended approach for bundlers.
 * Source: https://developer.mozilla.org/docs/Web/API/Worker/Worker#syntax
 *
 * This follows the same pattern as @brainstrike/embedding-worker's resolveEmbeddingWorkerUrl().
 * The worker TypeScript source is compiled to JavaScript by tsup during the package build.
 */
export function resolveTokenCacheWorkerUrl(): URL {
  if (typeof import.meta !== 'undefined' && typeof import.meta.url === 'string') {
    return new URL('./token-cache.worker.js', import.meta.url);
  }
  if (typeof import.meta.dirname === 'string') {
    return new URL('./token-cache.worker.js', `file://${import.meta.dirname}/`);
  }
  throw new Error('Unable to resolve token cache worker URL in this runtime');
}

/**
 * Resolve the background indexer worker URL that Vite/bundlers can turn into a `Worker` reference at runtime.
 * The `new URL(..., import.meta.url)` pattern is the MDN-recommended approach for bundlers.
 * Source: https://developer.mozilla.org/docs/Web/API/Worker/Worker#syntax
 *
 * This follows the same pattern as @brainstrike/embedding-worker's resolveEmbeddingWorkerUrl().
 * The worker TypeScript source is compiled to JavaScript by tsup during the package build.
 */
export function resolveBackgroundIndexerWorkerUrl(): URL {
  if (typeof import.meta !== 'undefined' && typeof import.meta.url === 'string') {
    return new URL('./background-indexer.worker.js', import.meta.url);
  }
  if (typeof import.meta.dirname === 'string') {
    return new URL('./background-indexer.worker.js', `file://${import.meta.dirname}/`);
  }
  throw new Error('Unable to resolve background indexer worker URL in this runtime');
}
