/**
 * useTokenCache React Hook
 *
 * Provides a React-friendly API for the persistent token cache.
 * Manages hot cache (in-memory) and cold cache (PGlite) with background worker.
 */

import {
  createLogger,
  normalizeFilePathForFolder,
  validateRelativeFilePath,
} from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const logger = createLogger('TokenCache');

/** Debounce delay for version updates to batch rapid-fire cache changes (ms) */
const VERSION_DEBOUNCE_MS = 50;

import type { FileHasher } from './file-hasher';
import type { TokenCacheStore } from './token-cache-store';
import type { TokenCacheEntry, TokenCountingMode, TokenCountResult } from './types';

/**
 * Minimal worker interface for token counting.
 * The cache runtime provides a dedicated Web Worker client that satisfies this contract.
 */
interface WorkerPoolLike {
  exec: (method: string, params: unknown[]) => Promise<unknown>;
}

/**
 * Options for useTokenCache hook
 */
export interface UseTokenCacheOptions {
  /** Current counting mode preference */
  countingMode: TokenCountingMode;
  /** File hasher instance */
  hasher: FileHasher;
  /** Callback when token count is resolved */
  onTokenResolved?: (folderId: string, filePath: string, tokenCount: number) => void;
  /** Token cache store instance */
  store: TokenCacheStore;
  /** Worker instance (minimal interface provided by the cache runtime) */
  workerPool: WorkerPoolLike;
}

/**
 * Return type for useTokenCache hook
 */
export interface UseTokenCacheReturn {
  /**
   * Version counter that increments when cache updates.
   * Use as a dependency in useMemo/useEffect to trigger re-renders on cache changes.
   */
  cacheVersion: number;

  /**
   * Clear hot cache (in-memory).
   * Does not affect persistent cache.
   */
  clearHotCache: () => void;

  /**
   * Get file size from persistent cache.
   * Returns cached value if available, otherwise undefined.
   * This is useful as a fallback when fileNodeCache hasn't loaded yet.
   *
   * @param folderId - Root folder identifier
   * @param filePath - Relative file path
   * @returns File size in bytes or undefined if not cached
   */
  getFileSize: (folderId: string, filePath: string) => number | undefined;
  /**
   * Get token count for a file.
   * Returns cached value if available, otherwise triggers background count.
   *
   * @param folderId - Root folder identifier
   * @param filePath - Relative file path
   * @param content - Optional file content (required for counting if not cached)
   * @returns Token count or null if loading
   */
  getTokenCount: (folderId: string, filePath: string, content?: string) => number | null;

  /**
   * Get aggregated token count for multiple files.
   * Uses SQL SUM for efficiency.
   */
  getTotalTokens: (folderId: string, filePaths: string[]) => Promise<number>;

  /**
   * Invalidate cache for specific files.
   * Use when file content has changed.
   */
  invalidate: (folderId: string, filePaths: string[]) => void;

  /**
   * Check if any token counting is in progress.
   */
  isAnyLoading: boolean;

  /**
   * Check if a file's token count is currently being computed.
   */
  isLoading: (folderId: string, filePath: string) => boolean;

  /**
   * Preload token counts from persistent cache.
   * Call this when folder is selected to warm the hot cache.
   */
  preloadFolder: (folderId: string) => Promise<void>;

  /**
   * Queue files for background token counting.
   */
  queueForCounting: (
    requests: Array<{
      folderId: string;
      filePath: string;
      content: string;
      fileSize?: number;
      mtimeMs?: number;
    }>
  ) => void;

  /**
   * Update file size cache directly.
   * Used by background indexer to populate cache without re-counting.
   */
  updateFileSizeCache: (folderId: string, filePath: string, fileSize: number) => void;

  /**
   * Update hot cache directly.
   * Used by background indexer to populate cache without re-counting.
   */
  updateHotCache: (folderId: string, filePath: string, tokenCount: number) => void;
}

/**
 * Create a composite cache key
 */
function createCacheKey(folderId: string, filePath: string): string {
  return `${folderId}::${filePath}`;
}

function normalizeCachePath(folderId: string, filePath: string): string {
  return validateRelativeFilePath(normalizeFilePathForFolder(filePath, folderId), {
    label: 'Token cache file path',
  });
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function tryNormalizeCachePath(folderId: string, filePath: string): string | null {
  try {
    return normalizeCachePath(folderId, filePath);
  } catch (error) {
    logger.warn('Rejected unsafe token cache file path before cache keying', {
      filePath,
      folderId,
      reason: formatErrorMessage(error),
    });
    return null;
  }
}

// Opt-in diagnostics: surface hot-cache hits/misses for one file when debugging
// cache-key mismatches. Keep scoped to a single key to avoid noisy logs.
const DIAG_KEY = (process.env['TOKEN_CACHE_DIAG_KEY'] as string | undefined) ?? '';
const diagLogger = DIAG_KEY ? createLogger('TokenCacheDiag') : null;

/**
 * React hook for persistent token caching with background worker.
 */
export function useTokenCache({
  store,
  hasher,
  workerPool,
  countingMode,
  onTokenResolved,
}: UseTokenCacheOptions): UseTokenCacheReturn {
  // Hot cache: in-memory for instant access
  const hotCache = useRef(new Map<string, number>());

  // File size cache: in-memory for instant access (populated alongside token cache)
  const fileSizeCache = useRef(new Map<string, number>());

  // Pending requests: track what's currently being processed
  const pendingRequests = useRef(new Set<string>());

  // Version counter to trigger re-renders when cache updates
  const [version, setVersion] = useState(0);

  // Debounce timer for batching version updates
  const versionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Note: isMountedRef is reset in the mount effect below to handle React StrictMode double-mount
  const isMountedRef = useRef(true);

  // Debounced version update to batch rapid-fire cache changes
  const debouncedSetVersion = useCallback(() => {
    if (!isMountedRef.current) {
      logger.warn('debouncedSetVersion skipped - component not mounted', {
        isMounted: isMountedRef.current,
      });
      return;
    }
    // Cancel any pending update
    if (versionDebounceRef.current) {
      clearTimeout(versionDebounceRef.current);
    }
    // Schedule a batched update
    versionDebounceRef.current = setTimeout(() => {
      if (isMountedRef.current) {
        logger.debug('Version increment triggered');
        setVersion((v) => v + 1);
      } else {
        logger.warn('Version increment skipped - unmounted during debounce');
      }
      versionDebounceRef.current = null;
    }, VERSION_DEBOUNCE_MS);
  }, []);

  // Track loading state
  const [loadingCount, setLoadingCount] = useState(0);

  // Memoize hasher initialization
  const hasherReady = useRef(false);
  useEffect(() => {
    void hasher.init().then(() => {
      hasherReady.current = true;
    });
  }, [hasher]);

  // Reset mounted flag on mount and cleanup on unmount (StrictMode compatibility)
  useEffect(() => {
    // Reset mounted flag on each mount (fixes React StrictMode double-mount issue)
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (versionDebounceRef.current) {
        clearTimeout(versionDebounceRef.current);
      }
    };
  }, []);

  /**
   * Load token count from persistent cache or trigger worker
   */
  const loadOrCount = useCallback(
    async (
      folderId: string,
      filePath: string,
      content: string,
      fileSize?: number,
      mtimeMs?: number
    ) => {
      const normalizedFilePath = tryNormalizeCachePath(folderId, filePath);
      if (!normalizedFilePath) {
        return;
      }
      const key = createCacheKey(folderId, normalizedFilePath);

      // Already processing
      if (pendingRequests.current.has(key)) {
        return;
      }

      pendingRequests.current.add(key);
      setLoadingCount((c) => c + 1);

      try {
        // Check persistent cache
        const cached = await store.get(folderId, normalizedFilePath);

        if (cached) {
          // Validate cache with content hash
          const contentHash = await hasher.hashContent(content);

          if (cached.contentHash === contentHash && cached.countingMode === countingMode) {
            // Cache hit - content unchanged
            hotCache.current.set(key, cached.tokenCount);
            fileSizeCache.current.set(key, cached.fileSize);
            debouncedSetVersion();
            onTokenResolved?.(folderId, normalizedFilePath, cached.tokenCount);
            return;
          }
        }

        // Cache miss or stale - count in worker
        const result = (await workerPool.exec('countTokens', [
          {
            content,
            id: key,
            mode: countingMode,
          },
        ])) as TokenCountResult;

        // Store in persistent cache
        const entry: TokenCacheEntry = {
          contentHash: result.contentHash,
          countingMode,
          filePath: normalizedFilePath,
          fileSize: fileSize ?? new Blob([content]).size,
          folderId,
          modelEncoding: countingMode === 'accurate' ? 'o200k_base' : null,
          mtimeMs: mtimeMs ?? null,
          tokenCount: result.tokenCount,
        };

        await store.set(entry);

        // Update hot cache and file size cache
        hotCache.current.set(key, result.tokenCount);
        fileSizeCache.current.set(key, entry.fileSize);
        debouncedSetVersion();
        onTokenResolved?.(folderId, normalizedFilePath, result.tokenCount);
      } catch (error) {
        // Log error but don't crash - token count will show as loading
        logger.error('Failed to count tokens', { error, filePath: normalizedFilePath, folderId });
      } finally {
        pendingRequests.current.delete(key);
        setLoadingCount((c) => c - 1);
      }
    },
    [store, hasher, workerPool, countingMode, onTokenResolved, debouncedSetVersion]
  );

  // Queue for deferred loading - avoids setState during render
  const deferredLoadQueue = useRef<Array<{ folderId: string; filePath: string; content: string }>>(
    []
  );

  // Process deferred loads in useEffect (after render completes)
  useEffect(() => {
    if (deferredLoadQueue.current.length === 0) {
      return;
    }
    // Copy and clear queue before processing to avoid infinite loops
    const toProcess = [...deferredLoadQueue.current];
    deferredLoadQueue.current = [];

    for (const { folderId, filePath, content } of toProcess) {
      const normalizedFilePath = tryNormalizeCachePath(folderId, filePath);
      if (!normalizedFilePath) {
        continue;
      }
      const key = createCacheKey(folderId, normalizedFilePath);
      // Double-check it's not already pending or cached
      if (!(pendingRequests.current.has(key) || hotCache.current.has(key))) {
        void loadOrCount(folderId, filePath, content);
      }
    }
  });

  /**
   * Get token count (synchronous, returns cached or null)
   */
  const getTokenCount = useCallback(
    (folderId: string, filePath: string, content?: string): number | null => {
      const normalizedFilePath = tryNormalizeCachePath(folderId, filePath);
      if (!normalizedFilePath) {
        return null;
      }
      const key = createCacheKey(folderId, normalizedFilePath);

      // Check hot cache first
      const cached = hotCache.current.get(key);
      if (DIAG_KEY && key === DIAG_KEY && diagLogger) {
        diagLogger.debug('token-cache diag: hot cache lookup', {
          hit: cached !== undefined,
          key,
          value: cached,
        });
      }
      if (cached !== undefined) {
        return cached;
      }

      // If content provided and not pending, queue for deferred loading
      // This avoids calling setState during render (React anti-pattern)
      if (content && !pendingRequests.current.has(key)) {
        deferredLoadQueue.current.push({ content, filePath: normalizedFilePath, folderId });
      }

      if (DIAG_KEY && key === DIAG_KEY && diagLogger) {
        diagLogger.debug('token-cache diag: cache miss', { hasContent: Boolean(content), key });
      }

      return null; // Loading
    },
    []
  );

  /**
   * Get file size (synchronous, returns cached or undefined)
   */
  const getFileSize = useCallback((folderId: string, filePath: string): number | undefined => {
    const normalizedFilePath = tryNormalizeCachePath(folderId, filePath);
    if (!normalizedFilePath) {
      return;
    }
    const key = createCacheKey(folderId, normalizedFilePath);
    return fileSizeCache.current.get(key);
  }, []);

  /**
   * Get total tokens for selection (async, uses SQL)
   */
  const getTotalTokens = useCallback(
    async (folderId: string, filePaths: string[]): Promise<number> => {
      const normalizedPaths = filePaths
        .map((filePath) => tryNormalizeCachePath(folderId, filePath))
        .filter((path): path is string => path !== null);
      if (normalizedPaths.length === 0) {
        return 0;
      }
      return store.getTotalTokens(folderId, normalizedPaths);
    },
    [store]
  );

  /**
   * Check if specific file is loading
   */
  const isLoading = useCallback((folderId: string, filePath: string): boolean => {
    const normalizedFilePath = tryNormalizeCachePath(folderId, filePath);
    if (!normalizedFilePath) {
      return false;
    }
    return pendingRequests.current.has(createCacheKey(folderId, normalizedFilePath));
  }, []);

  /**
   * Queue multiple files for counting
   */
  const queueForCounting = useCallback(
    (
      requests: Array<{
        folderId: string;
        filePath: string;
        content: string;
        fileSize?: number;
        mtimeMs?: number;
      }>
    ) => {
      for (const req of requests) {
        void loadOrCount(req.folderId, req.filePath, req.content, req.fileSize, req.mtimeMs);
      }
    },
    [loadOrCount]
  );

  /**
   * Preload folder from persistent cache
   */
  const preloadFolder = useCallback(
    async (folderId: string) => {
      const entries = await store.getAllForFolder(folderId);
      for (const entry of entries) {
        const key = createCacheKey(entry.folderId, entry.filePath);
        // Always cache file size (doesn't depend on counting mode)
        fileSizeCache.current.set(key, entry.fileSize);
        // Only use token cache if counting mode matches
        if (entry.countingMode === countingMode) {
          hotCache.current.set(key, entry.tokenCount);
        }
      }
      debouncedSetVersion();
    },
    [store, countingMode, debouncedSetVersion]
  );

  /**
   * Clear hot cache (token counts and file sizes)
   */
  const clearHotCache = useCallback(() => {
    hotCache.current.clear();
    fileSizeCache.current.clear();
    debouncedSetVersion();
  }, [debouncedSetVersion]);

  /**
   * Invalidate specific files (token counts and file sizes)
   */
  const invalidate = useCallback(
    (folderId: string, filePaths: string[]) => {
      for (const filePath of filePaths) {
        const normalizedFilePath = tryNormalizeCachePath(folderId, filePath);
        if (!normalizedFilePath) {
          continue;
        }
        const key = createCacheKey(folderId, normalizedFilePath);
        hotCache.current.delete(key);
        fileSizeCache.current.delete(key);
      }
      debouncedSetVersion();
    },
    [debouncedSetVersion]
  );

  /**
   * Update hot cache directly (for background indexer integration).
   * Skips update if value is already cached to avoid unnecessary UI churn and log noise.
   */
  const updateHotCache = useCallback(
    (folderId: string, filePath: string, tokenCount: number) => {
      const normalizedFilePath = tryNormalizeCachePath(folderId, filePath);
      if (!normalizedFilePath) {
        return;
      }
      const key = createCacheKey(folderId, normalizedFilePath);
      const existing = hotCache.current.get(key);
      if (existing === tokenCount) {
        // Already cached with same value - no update needed
        return;
      }
      hotCache.current.set(key, tokenCount);
      debouncedSetVersion();
    },
    [debouncedSetVersion]
  );

  /**
   * Update file size cache directly (for background indexer integration).
   * Skips update if value is already cached to avoid unnecessary UI churn and log noise.
   */
  const updateFileSizeCache = useCallback(
    (folderId: string, filePath: string, fileSize: number) => {
      const normalizedFilePath = tryNormalizeCachePath(folderId, filePath);
      if (!normalizedFilePath) {
        return;
      }
      const key = createCacheKey(folderId, normalizedFilePath);
      const existing = fileSizeCache.current.get(key);
      if (existing === fileSize) {
        // Already cached with same value - no update needed
        return;
      }
      fileSizeCache.current.set(key, fileSize);
      debouncedSetVersion();
    },
    [debouncedSetVersion]
  );

  // Clear hot cache when counting mode changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: countingMode triggers cache clear on mode switch
  useEffect(() => {
    clearHotCache();
  }, [countingMode, clearHotCache]);

  // NOTE: version is included in deps to trigger consumer re-renders when cache updates
  return useMemo(
    () => ({
      cacheVersion: version,
      clearHotCache,
      getFileSize,
      getTokenCount,
      getTotalTokens,
      invalidate,
      isAnyLoading: loadingCount > 0,
      isLoading,
      preloadFolder,
      queueForCounting,
      updateFileSizeCache,
      updateHotCache,
    }),
    [
      getTokenCount,
      getFileSize,
      getTotalTokens,
      isLoading,
      loadingCount,
      queueForCounting,
      preloadFolder,
      clearHotCache,
      invalidate,
      updateHotCache,
      updateFileSizeCache,
      version,
    ]
  );
}
