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

// Re-export Pool type for consumers (type-only import doesn't trigger runtime loading)
export type { Pool as WorkerPool } from 'workerpool';
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
// Re-export the worker URL resolvers for external consumers
export {
  resolveBackgroundIndexerWorkerUrl,
  resolveTokenCacheWorkerUrl,
} from './resolve-worker-url';
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

/**
 * Worker pool options type (re-exported for consumers).
 * Using inline type to avoid runtime import of workerpool.
 */
export interface WorkerPoolOptions {
  forkArgs?: string[];
  forkOpts?: object;
  maxQueueSize?: number;
  maxWorkers?: number;
  minWorkers?: number | 'max';
  onCreateWorker?: () => { on: unknown; forkArgs?: string[] };
  onTerminateWorker?: () => void;
  workerOpts?: {
    type?: 'classic' | 'module';
  };
  workerTerminateTimeout?: number;
  workerType?: 'auto' | 'web' | 'process' | 'thread';
}

/**
 * Worker pool interface (subset of workerpool.Pool used by this package).
 */
export interface WorkerPoolInterface {
  exec: (method: string, params: unknown[]) => Promise<unknown>;
  stats: () => {
    totalWorkers: number;
    busyWorkers: number;
    idleWorkers: number;
    pendingTasks: number;
    activeTasks: number;
  };
  terminate: (force?: boolean, timeout?: number) => Promise<void>;
}

// Lazy-loaded workerpool module to avoid loading worker_threads in browser/test environments
let workerpoolModule: typeof import('workerpool') | null = null;

async function getWorkerpool(): Promise<typeof import('workerpool')> {
  if (!workerpoolModule) {
    workerpoolModule = await import('workerpool');
  }
  return workerpoolModule;
}

/**
 * Create a worker pool for token counting.
 *
 * NOTE: This function dynamically imports workerpool to avoid loading worker_threads
 * at module initialization time, which would fail in browser/jsdom test environments.
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
 * const pool = await createTokenCacheWorkerPool(workerUrl);
 * ```
 */
export async function createTokenCacheWorkerPool(
  workerUrl: string,
  options?: WorkerPoolOptions
): Promise<WorkerPoolInterface> {
  const workerpool = await getWorkerpool();

  // Workerpool defaults to classic workers, which cannot run ES module syntax.
  // Force module workers so the ESM worker entry (token-cache.worker.ts) loads correctly.
  const workerOpts: { type?: 'classic' | 'module' } = {
    type: 'module',
    ...(options?.workerOpts ?? {}),
  };
  const workerType = options?.workerType ?? 'web';

  return workerpool.pool(workerUrl, {
    minWorkers: 1,
    maxWorkers: 2, // Token counting is CPU-bound, limit parallelism
    ...options,
    workerType,
    workerOpts,
  }) as unknown as WorkerPoolInterface;
}
