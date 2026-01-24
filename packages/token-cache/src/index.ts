/**
 * @brainstrike/token-cache
 *
 * Persistent token cache with background worker for file explorer.
 *
 * Features:
 * - PGlite-backed persistent storage
 * - xxHash64 content hashing for change detection
 * - Background Web Worker for non-blocking token counting
 * - Two-level caching (hot memory + cold PGlite)
 * - React hook for easy integration
 */

// Background Indexer Worker Types
export type {
  IndexerBatchRequest,
  IndexerError,
  IndexerProgress,
  IndexerRequest,
  IndexerResult,
  WorkerMessage,
  WorkerResponse,
} from './background-indexer.worker';
// File Hasher
export { __resetHasherForTests, FileHasher, fileHasher } from './file-hasher';
// Telemetry (BST-154)
export type {
  IndexedFileTelemetryEvent,
  IndexerTelemetryEvent,
  IndexerTelemetryEventType,
  IndexerTelemetryListener,
  IndexerTelemetrySnapshot,
  IndexingBacklogTelemetryEvent,
  IndexingErrorTelemetryEvent,
} from './telemetry';
export {
  addIndexerTelemetryListener,
  createIndexerTelemetryAggregator,
  emitIndexedFile,
  emitIndexerTelemetry,
  emitIndexingBacklog,
  emitIndexingError,
} from './telemetry';
// Token Cache Store
export { TokenCacheStore } from './token-cache-store';
// Types
export type {
  FileMetadata,
  TokenCacheEntry,
  TokenCacheStats,
  TokenCacheStoreOptions,
  TokenCountError,
  TokenCountingMode,
  TokenCountProgress,
  TokenCountRequest,
  TokenCountResult,
  TokenWorkerMessage,
} from './types';
export type {
  ElectronFileHandle,
  FileToIndex,
  IndexingProgress,
  UseBackgroundTokenIndexerOptions,
  UseBackgroundTokenIndexerReturn,
} from './use-background-token-indexer';
// Background Token Indexer (Web Worker based)
export { useBackgroundTokenIndexer } from './use-background-token-indexer';
// Telemetry React Hook (BST-154)
export type {
  UseIndexerTelemetryOptions,
  UseIndexerTelemetryReturn,
} from './use-indexer-telemetry';
export { useIndexerTelemetry } from './use-indexer-telemetry';
export type { UseTokenCacheOptions, UseTokenCacheReturn } from './use-token-cache';
// React Hooks
export { useTokenCache } from './use-token-cache';

// Worker pool factory
import * as workerpool from 'workerpool';

// Re-export Pool type for consumers
export type { Pool as WorkerPool } from 'workerpool';

// Re-export the worker URL resolvers for external consumers
export {
  resolveBackgroundIndexerWorkerUrl,
  resolveTokenCacheWorkerUrl,
} from './resolve-worker-url';

/**
 * Create a worker pool for token counting.
 *
 * @param workerUrl - URL to the worker script (use import.meta.url pattern)
 * @param options - Worker pool options
 * @returns Worker pool instance
 *
 * @example
 * ```typescript
 * // In your app initialization:
 * const workerUrl = new URL(
 *   '@brainstrike/token-cache/worker',
 *   import.meta.url
 * ).href;
 *
 * const pool = createTokenCacheWorkerPool(workerUrl);
 * ```
 */
export function createTokenCacheWorkerPool(
  workerUrl: string,
  options?: workerpool.WorkerPoolOptions
): workerpool.Pool {
  // Workerpool defaults to classic workers, which cannot run ES module syntax.
  // Force module workers so the ESM worker entry (token-cache.worker.ts) loads correctly.
  const workerOpts: NonNullable<workerpool.WorkerPoolOptions['workerOpts']> = {
    type: 'module',
    ...(options?.workerOpts ?? {}),
  };
  const workerType: workerpool.WorkerPoolOptions['workerType'] = options?.workerType ?? 'web';

  return workerpool.pool(workerUrl, {
    minWorkers: 1,
    maxWorkers: 2, // Token counting is CPU-bound, limit parallelism
    ...options,
    workerType,
    workerOpts,
  });
}
