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
 */

import type { MutableRefObject } from 'react';
import { useCallback, useRef } from 'react';
import { useOptionalTokenCacheContext } from './token-cache-context';
import type { TokenCountingState } from './use-token-counting';

/**
 * Props for the persistent token cache hook
 */
export type UsePersistentTokenCacheProps = {
  /** File contents by composite key (folderId::path) */
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
   * Get token count using persistent cache if available, otherwise in-memory
   */
  const getTokenCount = useCallback(
    (compositeKey: string): number | undefined => {
      const content = fileContents[compositeKey];

      // No content or inaccessible content
      if (!(content && isContentAccessible(content))) {
        return;
      }

      // --- Persistent Cache Path ---
      if (persistentCache?.isReady) {
        const { folderId, path } = decodeFileSelection(compositeKey);

        // getTokenCount returns number | null (null means loading)
        const count = persistentCache.getTokenCount(folderId, path, content);

        if (count !== null) {
          return count;
        }

        // Loading - return undefined to show spinner
        return;
      }

      // --- Fallback In-Memory Cache Path ---
      const cached = tokenCacheRef.current.get(compositeKey);
      if (typeof cached === 'number') {
        return cached;
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
  };
}
