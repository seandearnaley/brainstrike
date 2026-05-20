import backgroundIndexerWorkerUrlHref from '../../../token-cache/src/background-indexer.worker.ts?worker&url';
import tokenCacheWorkerUrlHref from '../../../token-cache/src/token-cache.worker.ts?worker&url';

/**
 * Keep token-cache worker graphs owned by the consuming app so Vite can emit
 * sibling chunks for dynamic imports inside the worker.
 */
export function resolveTokenCacheWorkerUrlHref(): string {
  return tokenCacheWorkerUrlHref;
}

/**
 * Keep background indexer worker graphs owned by the consuming app so Vite can
 * emit sibling chunks for dynamic imports inside the worker.
 */
export function resolveBackgroundIndexerWorkerUrlHref(): string {
  return backgroundIndexerWorkerUrlHref;
}
