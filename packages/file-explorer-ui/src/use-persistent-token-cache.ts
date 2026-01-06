/**
 * usePersistentTokenCache
 *
 * Bridge hook that integrates the persistent token cache with the preview panel.
 * Uses the TokenCacheContext when available, otherwise falls back to in-memory caching.
 *
 * Key Benefits:
 * - Token counts persist across sessions (stored in PGlite)
 * - Content-based invalidation using xxHash64
 * - Background worker for non-blocking counting
 * - SQL-based aggregation for total token counts
 * - Cache-first lookup (no content loading required for cached files)
 */

import type { MutableRefObject } from 'react';
import { useCallback, useRef } from 'react';
import { useOptionalTokenCacheContext } from './token-cache-context';
import type { TokenCountingState } from './use-token-counting';

/**
 * Props for the persistent token cache hook
 */
export type UsePersistentTokenCacheProps = {
  /** File contents by composite key (folderId::path) - now optional for cache hits */
  fileContents: Record<string, string>;
  /** Token counting state (old API) */
  tokenCounting: TokenCountingState;
  /** Decode composite key to folderId and path */
  decodeFileSelection: (compositeKey: string) => { folderId: string; path: string };
  /** Callback when token count is resolved (triggers re-render) */
  onTokenResolved: () => void;
};

/**
 * Return type for the persistent token cache hook
 */
export type UsePersistentTokenCacheReturn = {
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

  /**
   * Cache version counter that increments when hot cache updates.
   * Use as a dependency in useMemo/useEffect to trigger re-renders.
   */
  cacheVersion: number;
};

/**
 * Helper to check if content is accessible (not a placeholder message)
 */
function isContentAccessible(content: string): boolean {
  return !(content.startsWith('File not accessible') || content.startsWith('Binary file'));
}

/**
 * Hook that provides persistent token caching with fallback to in-memory.
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

  // Fallback in-memory cache (used when persistent cache is not available)
  const tokenCacheRef = useRef<Map<string, number>>(new Map());
  const pendingRequestsRef = useRef<Map<string, Promise<void>>>(new Map());

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
      if (persistentCache?.isOperational) {
        // Try to get from hot cache first (no content needed!)
        // Pass undefined for content to check cache only
        const content = fileContents[compositeKey];
        const count = persistentCache.getTokenCount(folderId, path, content);

        if (count !== null) {
          return count;
        }

        // Not in cache - if we have content, it will trigger counting
        // If no content, return undefined (shows as loading/unknown)
        return;
      }

      // --- Fallback In-Memory Cache Path ---
      const cached = tokenCacheRef.current.get(compositeKey);
      if (typeof cached === 'number') {
        return cached;
      }

      // Need content to count - check if available and accessible
      const content = fileContents[compositeKey];
      if (!(content && isContentAccessible(content))) {
        return;
      }

      // Not in cache and not pending - start counting
      if (!pendingRequestsRef.current.has(compositeKey)) {
        const pending = tokenCounting
          .countTokens(content)
          .then((count) => {
            tokenCacheRef.current.set(compositeKey, count);
          })
          .catch(() => {
            // Fall back to heuristic on error
            const heuristic = Math.ceil(content.length / 4);
            tokenCacheRef.current.set(compositeKey, heuristic);
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

  return {
    getTokenCount,
    isAnyLoading: persistentCache?.isAnyLoading ?? pendingRequestsRef.current.size > 0,
    pendingRequestsRef,
    tokenCacheRef,
    cacheVersion: persistentCache?.cacheVersion ?? 0,
  };
}
