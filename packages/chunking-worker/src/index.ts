/**
 * @brainstrike/chunking-worker
 *
 * Web Worker for off-main-thread file chunking with AST-aware code splitting and token counting.
 *
 * @example
 * ```ts
 * import { resolveChunkingWorkerUrl, type ChunkRequest, type ChunkResult } from '@brainstrike/chunking-worker';
 *
 * const worker = new Worker(resolveChunkingWorkerUrl(), { type: 'module' });
 *
 * worker.onmessage = (event) => {
 *   if (event.data.type === 'ready') {
 *     // Worker is ready
 *   } else if (event.data.type === 'result') {
 *     const result: ChunkResult = event.data;
 *     console.log('Chunks:', result.chunks);
 *   }
 * };
 *
 * worker.postMessage({
 *   type: 'chunk',
 *   id: 'request-1',
 *   fileRecordId: 'file-123',
 *   content: 'const x = 1;',
 *   fileName: 'example.ts',
 *   filePath: '/src/example.ts',
 *   options: { strategy: 'recursive' },
 * } satisfies ChunkRequest);
 * ```
 */

export type { CodeLanguage } from './chunking-config';

// Re-export chunking config for consumers
export { CHUNKING_CONFIG } from './chunking-config';
export type { PortableChunkingResult } from './portable-chunking';

// Re-export portable chunking for direct usage (if needed outside worker)
export { chunkContent } from './portable-chunking';
// Re-export shared types
export type {
  ChunkBatchRequest,
  ChunkError,
  ChunkingRequestOptions,
  ChunkingStrategy,
  ChunkProgress,
  ChunkRequest,
  ChunkResult,
  ChunkType,
  PortableChunk,
  WorkerLog,
  WorkerReady,
  WorkerRequest,
  WorkerResponse,
} from './shared';

/**
 * Resolve the chunking worker URL that Vite/bundlers can turn into a `Worker` reference at runtime.
 * The `new URL(..., import.meta.url)` pattern is the MDN-recommended approach for bundlers.
 * Source: https://developer.mozilla.org/docs/Web/API/Worker/Worker#syntax
 *
 * This follows the same pattern as @brainstrike/token-cache's resolveBackgroundIndexerWorkerUrl().
 * The worker TypeScript source is compiled to JavaScript by tsup during the package build.
 *
 * @example
 * ```ts
 * import { resolveChunkingWorkerUrl } from '@brainstrike/chunking-worker';
 *
 * const worker = new Worker(resolveChunkingWorkerUrl(), { type: 'module' });
 * ```
 */
export function resolveChunkingWorkerUrl(): URL {
  if (typeof import.meta !== 'undefined' && typeof import.meta.url === 'string') {
    return new URL('./chunking.worker.js', import.meta.url);
  }
  if (typeof import.meta.dirname === 'string') {
    return new URL('./chunking.worker.js', `file://${import.meta.dirname}/`);
  }
  throw new Error('Unable to resolve chunking worker URL in this runtime');
}
