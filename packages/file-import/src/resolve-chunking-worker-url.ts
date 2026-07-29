import { createLogger } from '@brainstrike/utils/logger';
// @boundaries-ignore Vite `?worker&url` must reference the worker SOURCE so the bundler owns the worker graph and emits sibling chunks (resolving the built package asset dropped them and broke desktop worker startup — see the doc comment below); the dependency on chunking-worker is declared.
import chunkingWorkerUrlHref from '../../chunking-worker/src/chunking.worker.ts?worker&url';

const logger = createLogger('resolveChunkingWorkerUrl');

type ChunkingWorkerUrlFactory = () => string;

function resolveBaseUrl(): string {
  if (typeof window !== 'undefined' && typeof window.location?.href === 'string') {
    return window.location.href;
  }
  return import.meta.url;
}

function createWorkspaceChunkingWorkerUrl(urlFactory: ChunkingWorkerUrlFactory): URL {
  return new URL(urlFactory(), resolveBaseUrl());
}

/**
 * Resolve the chunking worker URL that Vite/bundlers can turn into a Worker reference at runtime.
 * The `new URL(..., import.meta.url)` pattern is the MDN-recommended approach for bundlers.
 *
 * This intentionally resolves the source worker entry from the workspace instead of
 * delegating to the built package helper. The app bundlers must own the entire worker graph
 * so split worker chunks are emitted alongside the worker entry. Resolving the already-built
 * package asset only emitted the worker entry and dropped its sibling chunks, which broke
 * desktop worker startup after chunk splitting.
 *
 * This is intentionally Vite/workspace-coupled. Do not reuse it from published package code
 * or non-Vite bundlers without replacing the `?worker&url` import contract first.
 */
export async function resolveChunkingWorkerUrl(
  urlFactory: ChunkingWorkerUrlFactory = () => chunkingWorkerUrlHref
): Promise<URL> {
  try {
    const url = createWorkspaceChunkingWorkerUrl(urlFactory);
    logger.debug('Resolved chunking worker URL from workspace source', { url: url.href });
    return url;
  } catch (error) {
    logger.error('Failed to resolve chunking worker URL from workspace source', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(
      `Failed to resolve chunking worker URL: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
