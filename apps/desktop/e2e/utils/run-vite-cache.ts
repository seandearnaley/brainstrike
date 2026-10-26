import type { InlineConfig } from 'vite';

/** Names the run-level dev renderer dependency cache global setup optimized. */
export const E2E_VITE_CACHE_DIR_ENV = 'BRAINSTRIKE_E2E_VITE_CACHE_DIR';

/**
 * The vite settings a dev-server spec uses to serve from the run's optimized cache: it reads
 * the committed metadata and never discovers, so it neither optimizes nor rewrites the cache
 * other workers read. A dependency global setup's scan missed is served unoptimized, never
 * re-bundled mid-launch.
 */
export function runViteCache(): Pick<InlineConfig, 'cacheDir' | 'optimizeDeps'> {
  const cacheDir = process.env[E2E_VITE_CACHE_DIR_ENV];
  if (!cacheDir) {
    throw new Error(`${E2E_VITE_CACHE_DIR_ENV} is unset: global setup optimizes the run's cache`);
  }
  return { cacheDir, optimizeDeps: { noDiscovery: true } };
}
