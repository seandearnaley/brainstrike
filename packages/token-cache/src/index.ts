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

// File Hasher
export { __resetHasherForTests, FileHasher, fileHasher } from './file-hasher';
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
export type { UseTokenCacheOptions, UseTokenCacheReturn } from './use-token-cache';
// React Hook
export { useTokenCache } from './use-token-cache';

// Worker pool factory
import * as workerpool from 'workerpool';

// Re-export Pool type for consumers
export type { Pool as WorkerPool } from 'workerpool';

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
  return workerpool.pool(workerUrl, {
    minWorkers: 1,
    maxWorkers: 2, // Token counting is CPU-bound, limit parallelism
    ...options,
  });
}
