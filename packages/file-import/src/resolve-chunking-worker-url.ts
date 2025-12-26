/**
 * Resolve the chunking worker URL.
 *
 * This follows the same pattern as token-cache's resolve-worker-url.ts.
 * The worker is built by @brainstrike/chunking-worker and we reference it directly.
 *
 * IMPORTANT: This file must be in the same package that uses the worker
 * to ensure import.meta.url resolves correctly when bundled.
 */

import { createLogger } from '@brainstrike/utils';

const logger = createLogger('resolveChunkingWorkerUrl');

/**
 * Resolve the chunking worker URL that Vite/bundlers can turn into a Worker reference at runtime.
 * The `new URL(..., import.meta.url)` pattern is the MDN-recommended approach for bundlers.
 *
 * We import the chunking-worker package dynamically to get its URL resolver,
 * or fall back to a direct path if that fails.
 */
export async function resolveChunkingWorkerUrl(): Promise<URL> {
  try {
    // Try importing from the chunking-worker package
    const { resolveChunkingWorkerUrl: resolve } = await import('@brainstrike/chunking-worker');
    const url = resolve();
    logger.debug('Resolved chunking worker URL from package', { url: url.href });
    return url;
  } catch (error) {
    logger.error('Failed to import @brainstrike/chunking-worker', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(
      `Failed to resolve chunking worker URL: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
