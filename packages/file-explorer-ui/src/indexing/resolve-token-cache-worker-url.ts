// @boundaries-ignore Vite `?worker&url` must reference the worker SOURCE so the bundler owns the worker graph and emits sibling chunks for its dynamic imports (see below); token-cache's bundled dist worker cannot provide that. Same pattern as file-import's chunking-worker URL resolvers.
import backgroundIndexerWorkerUrlHref from '../../../token-cache/src/background-indexer.worker.ts?worker&url';
// @boundaries-ignore see above — worker-URL source imports are deliberate; the package dependency on token-cache is declared.
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
