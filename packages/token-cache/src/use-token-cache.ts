/**
 * useTokenCache React Hook
 *
 * Provides a React-friendly API for the persistent token cache.
 * Manages hot cache (in-memory) and cold cache (PGlite) with background worker.
 */

import { createLogger } from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const logger = createLogger('TokenCache');

/** Debounce delay for version updates to batch rapid-fire cache changes (ms) */
const VERSION_DEBOUNCE_MS = 50;

import type { Pool } from 'workerpool';
import type { FileHasher } from './file-hasher';
import type { TokenCacheStore } from './token-cache-store';
import type { TokenCacheEntry, TokenCountingMode, TokenCountResult } from './types';

/**
 * Options for useTokenCache hook
 */
export type UseTokenCacheOptions = {
  /** Token cache store instance */
  store: TokenCacheStore;
  /** File hasher instance */
  hasher: FileHasher;
  /** Worker pool instance */
  workerPool: Pool;
  /** Current counting mode preference */
  countingMode: TokenCountingMode;
  /** Callback when token count is resolved */
  onTokenResolved?: (folderId: string, filePath: string, tokenCount: number) => void;
};

/**
 * Return type for useTokenCache hook
 */
export type UseTokenCacheReturn = {
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
   * Check if a file's token count is currently being computed.
   */
  isLoading: (folderId: string, filePath: string) => boolean;

  /**
   * Check if any token counting is in progress.
   */
  isAnyLoading: boolean;

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
   * Preload token counts from persistent cache.
   * Call this when folder is selected to warm the hot cache.
   */
  preloadFolder: (folderId: string) => Promise<void>;

  /**
   * Clear hot cache (in-memory).
   * Does not affect persistent cache.
   */
  clearHotCache: () => void;

  /**
   * Invalidate cache for specific files.
   * Use when file content has changed.
   */
  invalidate: (folderId: string, filePaths: string[]) => void;

  /**
   * Update hot cache directly.
   * Used by background indexer to populate cache without re-counting.
   */
  updateHotCache: (folderId: string, filePath: string, tokenCount: number) => void;

  /**
   * Version counter that increments when cache updates.
   * Use as a dependency in useMemo/useEffect to trigger re-renders on cache changes.
   */
  cacheVersion: number;
};

/**
 * Create a composite cache key
 */
function createCacheKey(folderId: string, filePath: string): string {
  return `${folderId}::${filePath}`;
}

// Temporary diagnostics: surface hot-cache hits/misses for a single file to confirm UI read path.
// NOTE: keep scoped to a single key to avoid noisy logs; remove after validation.
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
      const key = createCacheKey(folderId, filePath);

      // Already processing
      if (pendingRequests.current.has(key)) {
        return;
      }

      pendingRequests.current.add(key);
      setLoadingCount((c) => c + 1);

      try {
        // Check persistent cache
        const cached = await store.get(folderId, filePath);

        if (cached) {
          // Validate cache with content hash
          const contentHash = await hasher.hashContent(content);

          if (cached.contentHash === contentHash && cached.countingMode === countingMode) {
            // Cache hit - content unchanged
            hotCache.current.set(key, cached.tokenCount);
            debouncedSetVersion();
            onTokenResolved?.(folderId, filePath, cached.tokenCount);
            return;
          }
        }

        // Cache miss or stale - count in worker
        const result = (await workerPool.exec('countTokens', [
          {
            id: key,
            content,
            mode: countingMode,
          },
        ])) as TokenCountResult;

        // Store in persistent cache
        const entry: TokenCacheEntry = {
          folderId,
          filePath,
          contentHash: result.contentHash,
          fileSize: fileSize ?? new Blob([content]).size,
          mtimeMs: mtimeMs ?? null,
          tokenCount: result.tokenCount,
          countingMode,
          modelEncoding: countingMode === 'accurate' ? 'o200k_base' : null,
        };

        await store.set(entry);

        // Update hot cache
        hotCache.current.set(key, result.tokenCount);
        debouncedSetVersion();
        onTokenResolved?.(folderId, filePath, result.tokenCount);
      } catch (error) {
        // Log error but don't crash - token count will show as loading
        // biome-ignore lint/suspicious/noConsole: Error logging in cache
        console.error('[TokenCache] Failed to count tokens:', { folderId, filePath, error });
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
      const key = createCacheKey(folderId, filePath);
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
      const key = createCacheKey(folderId, filePath);

      // Check hot cache first
      const cached = hotCache.current.get(key);
      if (DIAG_KEY && key === DIAG_KEY && diagLogger) {
        diagLogger.debug('token-cache diag: hot cache lookup', {
          key,
          hit: cached !== undefined,
          value: cached,
        });
      }
      if (cached !== undefined) {
        return cached;
      }

      // If content provided and not pending, queue for deferred loading
      // This avoids calling setState during render (React anti-pattern)
      if (content && !pendingRequests.current.has(key)) {
        deferredLoadQueue.current.push({ folderId, filePath, content });
      }

      if (DIAG_KEY && key === DIAG_KEY && diagLogger) {
        diagLogger.debug('token-cache diag: cache miss', { key, hasContent: Boolean(content) });
      }

      return null; // Loading
    },
    []
  );

  /**
   * Get total tokens for selection (async, uses SQL)
   */
  const getTotalTokens = useCallback(
    async (folderId: string, filePaths: string[]): Promise<number> =>
      store.getTotalTokens(folderId, filePaths),
    [store]
  );

  /**
   * Check if specific file is loading
   */
  const isLoading = useCallback(
    (folderId: string, filePath: string): boolean =>
      pendingRequests.current.has(createCacheKey(folderId, filePath)),
    []
  );

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
        // Only use cache if counting mode matches
        if (entry.countingMode === countingMode) {
          const key = createCacheKey(entry.folderId, entry.filePath);
          hotCache.current.set(key, entry.tokenCount);
        }
      }
      debouncedSetVersion();
    },
    [store, countingMode, debouncedSetVersion]
  );

  /**
   * Clear hot cache
   */
  const clearHotCache = useCallback(() => {
    hotCache.current.clear();
    debouncedSetVersion();
  }, [debouncedSetVersion]);

  /**
   * Invalidate specific files
   */
  const invalidate = useCallback(
    (folderId: string, filePaths: string[]) => {
      for (const filePath of filePaths) {
        const key = createCacheKey(folderId, filePath);
        hotCache.current.delete(key);
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
      const key = createCacheKey(folderId, filePath);
      const existing = hotCache.current.get(key);
      if (existing === tokenCount) {
        // Already cached with same value - no update needed
        return;
      }
      hotCache.current.set(key, tokenCount);
      logger.info('Hot cache updated', { key, tokenCount, cacheSize: hotCache.current.size });
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
      getTokenCount,
      getTotalTokens,
      isLoading,
      isAnyLoading: loadingCount > 0,
      queueForCounting,
      preloadFolder,
      clearHotCache,
      invalidate,
      updateHotCache,
      cacheVersion: version,
    }),
    [
      getTokenCount,
      getTotalTokens,
      isLoading,
      loadingCount,
      queueForCounting,
      preloadFolder,
      clearHotCache,
      invalidate,
      updateHotCache,
      version,
    ]
  );
}
