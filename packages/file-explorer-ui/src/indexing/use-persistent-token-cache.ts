/**
 * usePersistentTokenCache
 *
 * Bridge hook that integrates the persistent token cache with the context explorer panel.
 * Uses the TokenCacheContext when available, otherwise keeps a strict in-memory request/cache layer.
 *
 * Key Benefits:
 * - Token counts persist across sessions (stored in the configured persistent token-cache store)
 * - Content-based invalidation using xxHash64
 * - Background worker for non-blocking counting
 * - SQL-based aggregation for total token counts
 * - Cache-first lookup (no content loading required for cached files)
 */

import { INACCESSIBLE_CONTENT_PREFIX } from '@brainstrike/file-explorer-hooks';
import { createLogger } from '@brainstrike/utils/logger';
import { normalizeSelectionPathForFolder } from '@brainstrike/utils/relative-file-path';
import type { MutableRefObject } from 'react';
import { useCallback, useRef } from 'react';
import { type TokenCacheContextValue, useOptionalTokenCacheContext } from './token-cache-context';
import type { TokenCountingState } from './use-token-counting';

const logger = createLogger('PersistentTokenCache');
const FAILED_REQUEST_RETRY_COOLDOWN_MS = 5000;

interface FailedRequestState {
  failedAt: number;
  stateKey: string;
}

interface CachedSelectionStats {
  cachedFileCount: number;
  tokenCounts: ReadonlyMap<string, number>;
  totalTokens: number;
}

function normalizeSelectionPath(folderId: string, filePath: string): string {
  return normalizeSelectionPathForFolder(filePath, folderId, {
    label: 'Token cache file path',
  });
}

function tryNormalizeSelectionPath(folderId: string, filePath: string): string | null {
  try {
    return normalizeSelectionPath(folderId, filePath);
  } catch (error) {
    logger.warn('Rejected unsafe token cache file path before persistent cache access', {
      filePath,
      folderId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Props for the persistent token cache hook
 */
export interface UsePersistentTokenCacheProps {
  /** Decode composite key to folderId and path */
  decodeFileSelection: (compositeKey: string) => { folderId: string; path: string };
  /** File contents by composite key (folderId::path) - now optional for cache hits */
  fileContents: Record<string, string>;
  /** Callback when token count is resolved (triggers re-render) */
  onTokenResolved: () => void;
  /** Token counting state (old API) */
  tokenCounting: TokenCountingState;
}

/**
 * Return type for the persistent token cache hook
 */
export interface UsePersistentTokenCacheReturn {
  /**
   * Cache version counter that increments when hot cache updates.
   * Use as a dependency in useMemo/useEffect to trigger re-renders.
   */
  cacheVersion: number;

  /**
   * Get cached token counts for files in a selection.
   * Returns only files already present in cache/store; uncached files are excluded.
   */
  getCachedSelectionStats: (compositeKeys: Iterable<string>) => Promise<CachedSelectionStats>;

  /**
   * Get file size from persistent cache.
   * Returns cached value or undefined if not available.
   * This is useful as a fallback when fileNodeCache hasn't loaded yet.
   */
  getFileSize: (compositeKey: string) => number | undefined;
  /**
   * Get token count for a file.
   * Returns cached value or undefined if loading.
   */
  getTokenCount: (compositeKey: string) => number | undefined;

  /**
   * Check if any token counting is in progress
   */
  isAnyLoading: boolean;

  /**
   * Reference to pending requests (for compatibility with legacy code)
   */
  pendingRequestsRef: MutableRefObject<Map<string, Promise<void>>>;

  /**
   * Reference to in-memory cache (for compatibility with legacy code)
   */
  tokenCacheRef: MutableRefObject<Map<string, number>>;
}

/**
 * Helper to check if content is accessible (not a placeholder message)
 */
function isContentAccessible(content: string): boolean {
  return !(content.startsWith(INACCESSIBLE_CONTENT_PREFIX) || content.startsWith('Binary file'));
}

function shouldDelayRetry(
  failedRequests: Map<string, FailedRequestState>,
  compositeKey: string,
  countingRuntimeStateKey: string
): boolean {
  const failedState = failedRequests.get(compositeKey);
  if (!failedState) {
    return false;
  }

  if (failedState.stateKey !== countingRuntimeStateKey) {
    failedRequests.delete(compositeKey);
    return false;
  }

  const retryAt = failedState.failedAt + FAILED_REQUEST_RETRY_COOLDOWN_MS;
  if (Date.now() < retryAt) {
    return true;
  }

  failedRequests.delete(compositeKey);
  return false;
}

function buildCompositeKeysByFolder(
  compositeKeys: Iterable<string>,
  decodeFileSelection: (compositeKey: string) => { folderId: string; path: string }
): Map<string, Map<string, string>> {
  const compositeKeysByFolder = new Map<string, Map<string, string>>();

  for (const compositeKey of compositeKeys) {
    const { folderId, path } = decodeFileSelection(compositeKey);
    const normalizedPath = tryNormalizeSelectionPath(folderId, path);
    if (!normalizedPath) {
      continue;
    }
    const folderCompositeKeys = compositeKeysByFolder.get(folderId) ?? new Map<string, string>();
    folderCompositeKeys.set(normalizedPath, compositeKey);
    compositeKeysByFolder.set(folderId, folderCompositeKeys);
  }

  return compositeKeysByFolder;
}

async function readPersistentSelectionStats(
  folderSelections: Map<string, Map<string, string>>,
  store: NonNullable<TokenCacheContextValue['store']>
): Promise<CachedSelectionStats> {
  const folderResults = await Promise.all(
    Array.from(folderSelections, async ([folderId, folderCompositeKeys]) => ({
      entries: await store.getBatch(folderId, Array.from(folderCompositeKeys.keys())),
      folderCompositeKeys,
    }))
  );

  let cachedFileCount = 0;
  const tokenCounts = new Map<string, number>();
  let totalTokens = 0;

  for (const { entries, folderCompositeKeys } of folderResults) {
    cachedFileCount += entries.size;
    for (const [filePath, entry] of entries) {
      const compositeKey = folderCompositeKeys.get(filePath);
      if (compositeKey === undefined) {
        continue;
      }
      tokenCounts.set(compositeKey, entry.tokenCount);
      totalTokens += entry.tokenCount;
    }
  }

  return { cachedFileCount, tokenCounts, totalTokens };
}

function readInMemorySelectionStats(
  compositeKeys: Iterable<string>,
  tokenCache: ReadonlyMap<string, number>
): CachedSelectionStats {
  let cachedFileCount = 0;
  const tokenCounts = new Map<string, number>();
  let totalTokens = 0;

  for (const compositeKey of compositeKeys) {
    const cached = tokenCache.get(compositeKey);
    if (typeof cached !== 'number') {
      continue;
    }
    tokenCounts.set(compositeKey, cached);
    cachedFileCount += 1;
    totalTokens += cached;
  }

  return { cachedFileCount, tokenCounts, totalTokens };
}

/**
 * Hook that provides persistent token caching with a strict in-memory request/cache layer.
 *
 * Usage:
 * ```tsx
 * const { getTokenCount, isAnyLoading } = usePersistentTokenCache({
 *   fileContents,
 *   tokenCounting,
 *   decodeFileSelection,
 *   onTokenResolved,
 * });
 * ```
 */
export function usePersistentTokenCache({
  fileContents,
  tokenCounting,
  decodeFileSelection,
  onTokenResolved,
}: UsePersistentTokenCacheProps): UsePersistentTokenCacheReturn {
  // Try to get the persistent cache context (may be null if not wrapped in provider)
  const persistentCache = useOptionalTokenCacheContext();

  // In-memory request/cache layer used when the persistent cache context is unavailable.
  const tokenCacheRef = useRef<Map<string, number>>(new Map());
  const pendingRequestsRef = useRef<Map<string, Promise<void>>>(new Map());
  const failedRequestsRef = useRef<Map<string, FailedRequestState>>(new Map());
  const countingRuntimeStateKey = `${tokenCounting.mode}:${tokenCounting.reason ?? 'ready'}`;

  /**
   * Get token count using persistent cache if available, otherwise in-memory.
   *
   * IMPORTANT: Cache-first lookup - for files that have been indexed before,
   * we can return the cached count WITHOUT requiring content to be loaded.
   * Content is only needed when counting a file for the first time.
   */
  const getTokenCount = useCallback(
    (compositeKey: string): number | undefined => {
      const { folderId, path } = decodeFileSelection(compositeKey);

      // --- Persistent Cache Path (preferred) ---
      if (persistentCache) {
        if (!persistentCache.isOperational) {
          // A provider exists, so token counting is expected to come from the shared worker path.
          // Do not fall through to the strict in-memory path while that runtime is still booting.
          return;
        }

        const normalizedPath = tryNormalizeSelectionPath(folderId, path);
        if (!normalizedPath) {
          return;
        }

        // Try to get from hot cache first (no content needed!)
        // Pass undefined for content to check cache only
        const content = fileContents[compositeKey];
        const count = persistentCache.getTokenCount(folderId, normalizedPath, content);

        if (count !== null) {
          return count;
        }

        // Not in cache - if we have content, it will trigger counting
        // If no content, return undefined (shows as loading/unknown)
        return;
      }

      // --- Strict In-Memory Cache Path ---
      // This path is only valid when no shared token-cache provider exists at all.
      const cached = tokenCacheRef.current.get(compositeKey);
      if (typeof cached === 'number') {
        return cached;
      }

      // Need content to count - check if available and accessible
      const content = fileContents[compositeKey];
      if (!(content && isContentAccessible(content))) {
        return;
      }

      if (shouldDelayRetry(failedRequestsRef.current, compositeKey, countingRuntimeStateKey)) {
        return;
      }

      // Not in cache and not pending - start counting
      if (!pendingRequestsRef.current.has(compositeKey)) {
        const pending = tokenCounting
          .countTokens(content)
          .then((count) => {
            failedRequestsRef.current.delete(compositeKey);
            tokenCacheRef.current.set(compositeKey, count);
          })
          .catch((error: unknown) => {
            logger.warn('Strict token counting failed', {
              compositeKey,
              countingMode: tokenCounting.mode,
              error,
            });
            failedRequestsRef.current.set(compositeKey, {
              stateKey: countingRuntimeStateKey,
              failedAt: Date.now(),
            });
          })
          .finally(() => {
            pendingRequestsRef.current.delete(compositeKey);
            onTokenResolved();
          });

        pendingRequestsRef.current.set(compositeKey, pending);
      }

      return;
    },
    [fileContents, persistentCache, tokenCounting, decodeFileSelection, onTokenResolved]
  );

  /**
   * Get file size using persistent cache if available.
   * This is useful as a fallback when fileNodeCache hasn't loaded yet.
   */
  const getFileSize = useCallback(
    (compositeKey: string): number | undefined => {
      const { folderId, path } = decodeFileSelection(compositeKey);

      // Use persistent cache if available
      if (persistentCache?.isOperational) {
        const normalizedPath = tryNormalizeSelectionPath(folderId, path);
        if (!normalizedPath) {
          return;
        }
        return persistentCache.getFileSize(folderId, normalizedPath);
      }

      // No fallback for file size in in-memory mode
      return;
    },
    [persistentCache, decodeFileSelection]
  );

  const getCachedSelectionStats = useCallback(
    async (compositeKeys: Iterable<string>): Promise<CachedSelectionStats> => {
      if (persistentCache?.isOperational) {
        return await readPersistentSelectionStats(
          buildCompositeKeysByFolder(compositeKeys, decodeFileSelection),
          persistentCache.store
        );
      }

      return readInMemorySelectionStats(compositeKeys, tokenCacheRef.current);
    },
    [decodeFileSelection, persistentCache]
  );

  return {
    getTokenCount,
    getFileSize,
    getCachedSelectionStats,
    isAnyLoading: persistentCache?.isAnyLoading ?? pendingRequestsRef.current.size > 0,
    pendingRequestsRef,
    tokenCacheRef,
    cacheVersion: persistentCache?.cacheVersion ?? 0,
  };
}
