/**
 * Resolve the chunking worker URL.
 *
 * This follows the same pattern as token-cache's resolve-worker-url.ts.
 * The worker is built by @brainstrike/chunking-worker and we reference it directly.
 *
 * IMPORTANT: This file must be in the same package that uses the worker
 * to ensure import.meta.url resolves correctly when bundled.
 */

import { resolveChunkingWorkerUrl as resolveChunkingWorkerUrlFromPackage } from '@brainstrike/chunking-worker';
import { createLogger } from '@brainstrike/utils';

const logger = createLogger('resolveChunkingWorkerUrl');

/**
 * Resolve the chunking worker URL that Vite/bundlers can turn into a Worker reference at runtime.
 * The `new URL(..., import.meta.url)` pattern is the MDN-recommended approach for bundlers.
 *
 * We keep a static import to preserve bundler worker-asset rewriting in built Electron/web
 * environments. Dynamic import here caused built desktop chunking-host worker startup failures.
 *
 * CRITICAL: Do not add a direct-path fallback here.
 * A production `file://.../dist/...` fallback in non-packaged dev has repeatedly
 * broken module worker loading and caused chunking regressions.
 */
export async function resolveChunkingWorkerUrl(): Promise<URL> {
  try {
    const url = resolveChunkingWorkerUrlFromPackage();
    logger.debug('Resolved chunking worker URL from package', { url: url.href });
    return url;
  } catch (error) {
    logger.error('Failed to resolve @brainstrike/chunking-worker URL', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(
      `Failed to resolve chunking worker URL: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
