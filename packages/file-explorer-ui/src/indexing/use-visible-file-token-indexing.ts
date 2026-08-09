/**
 * VISIBLE-file token indexing trigger (BST-1207, decision D2).
 *
 * The background indexer historically started work only when files were
 * SELECTED, so the Explorer tree's token column had nothing to show for rows
 * the user had merely expanded. This hook adds a SECOND trigger source without
 * touching the first: it feeds visible/expanded files through the very same
 * `triggerIndexing` (and therefore the same dispatch planner, binary/size
 * policy, and indexed/in-flight de-duplication) as the selection trigger.
 *
 * Two properties keep it subordinate to the selection path:
 *
 * - **Cached-first.** Each involved folder's persistent cache is warmed, then
 *   every key the cache can already answer is dropped (and marked indexed, so
 *   later passes skip the probe). Only genuine misses cost any work. A warm is
 *   memoized ONLY once persistence is up: while the DB is still booting
 *   `preloadFolder` is a no-op, and remembering that no-op would strand every
 *   visible file on a full re-count for the rest of the session.
 * - **Throttled.** The `VISIBLE_FILE_INDEXING_DEBOUNCE_MS` floor is 2× the
 *   selection trigger's longest adaptive delay, so visible work sits behind
 *   selection work for every batch size except the degenerate case where a huge
 *   selection and a tiny visible set land in the same window. The two debounces
 *   are independent — this is a strong bias, not an ordering guarantee.
 *
 * State (`indexedFilesRef`, `inFlightRef`, `preloadedFoldersRef`) is SHARED
 * with the selection trigger by design: whichever trigger reaches a file first,
 * the other must not queue it again, and the parent owns the single reset point
 * for all of it (root change, tree clear, `clearIndexedCache`).
 */

import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import { createLogger } from '@brainstrike/logging';
import type { MutableRefObject } from 'react';
import { useCallback, useEffect } from 'react';
import { getAdaptiveDebounceMs, VISIBLE_FILE_INDEXING_DEBOUNCE_MS } from '../constants';
import type { HandleInfo } from './background-token-indexer-handles';
import type { TokenCacheContextValue } from './token-cache-context';

const logger = createLogger('VisibleFileTokenIndexing');

type IndexGetHandle = (folderId: string, path: string) => HandleInfo | undefined;

export interface UseVisibleFileTokenIndexingParams {
  /** Local handle map; a non-empty map means handles can be resolved. */
  fileHandleMapRef: MutableRefObject<Map<string, HandleInfo>>;
  /** Re-arms the effect when the local handle map finishes rebuilding. */
  fileHandleMapSize: number;
  /** Shared with the selection trigger: keys already counted or queued. */
  indexedFilesRef: MutableRefObject<Set<string>>;
  /** Shared FileTreeIndex lookup; present means handles can be resolved. */
  indexGetHandleRef: MutableRefObject<IndexGetHandle | undefined>;
  /** Bumps when the FileTreeIndex gains handles; re-arms parked keys. */
  indexVersion: number;
  /** Shared with the selection trigger: keys currently being counted. */
  inFlightRef: MutableRefObject<Set<string>>;
  isTokenCacheOperational: boolean;
  /** Re-arms the effect when the DB comes up, so a no-op warm gets retried. */
  isTokenCachePersisted: boolean;
  /** Parent-owned memo of folders already warmed for THIS trigger. */
  preloadedFoldersRef: MutableRefObject<Set<string>>;
  tokenCacheRef: MutableRefObject<TokenCacheContextValue | null>;
  /** The selection trigger's dispatch path, reused verbatim. */
  triggerIndexing: (compositeKeys: string[]) => Promise<void>;
  /** Composite keys of files visible in the tree, or undefined when unused. */
  visibleFiles: ReadonlySet<string> | undefined;
}

export function useVisibleFileTokenIndexing({
  fileHandleMapRef,
  fileHandleMapSize,
  indexGetHandleRef,
  indexedFilesRef,
  indexVersion,
  inFlightRef,
  isTokenCacheOperational,
  isTokenCachePersisted,
  preloadedFoldersRef,
  tokenCacheRef,
  triggerIndexing,
  visibleFiles,
}: UseVisibleFileTokenIndexingParams): void {
  const indexVisibleFiles = useCallback(
    async (compositeKeys: readonly string[]): Promise<void> => {
      const cache = tokenCacheRef.current;
      if (!cache?.isOperational) {
        return;
      }

      const folderIds = new Set<string>();
      for (const compositeKey of compositeKeys) {
        folderIds.add(decodeFileSelection(compositeKey).folderId);
      }
      const warmups: Promise<void>[] = [];
      for (const folderId of folderIds) {
        if (preloadedFoldersRef.current.has(folderId)) {
          continue;
        }
        warmups.push(
          cache.preloadFolder(folderId).then(() => {
            // Only remember a warm that could actually have read the DB. Before
            // persistence is up `preloadFolder` reads nothing, and memoizing
            // that would defeat cached-first for the whole session.
            if (tokenCacheRef.current?.isPersisted) {
              preloadedFoldersRef.current.add(folderId);
            }
          })
        );
      }
      await Promise.all(warmups);

      const uncachedKeys: string[] = [];
      for (const compositeKey of compositeKeys) {
        const { folderId, path } = decodeFileSelection(compositeKey);
        // `getTokenCount` normalizes the path itself (non-throwing: an unsafe
        // path reads as a miss), so unsafe paths fall through to the dispatch
        // planner, which classifies and logs them.
        if (cache.getTokenCount(folderId, path) === null) {
          uncachedKeys.push(compositeKey);
          continue;
        }
        indexedFilesRef.current.add(compositeKey);
      }

      logger.debug('Visible-file indexing pass prepared', {
        cachedCount: compositeKeys.length - uncachedKeys.length,
        requestedFiles: compositeKeys.length,
        uncachedCount: uncachedKeys.length,
      });

      if (uncachedKeys.length > 0) {
        await triggerIndexing(uncachedKeys);
      }
    },
    [indexedFilesRef, preloadedFoldersRef, tokenCacheRef, triggerIndexing]
  );

  useEffect(() => {
    if (!visibleFiles || visibleFiles.size === 0) {
      return;
    }
    const hasHandleSource = Boolean(indexGetHandleRef.current) || fileHandleMapRef.current.size > 0;
    if (!(tokenCacheRef.current?.isOperational && hasHandleSource)) {
      return;
    }

    const newFiles = Array.from(visibleFiles).filter(
      (compositeKey) =>
        !(indexedFilesRef.current.has(compositeKey) || inFlightRef.current.has(compositeKey))
    );
    if (newFiles.length === 0) {
      return;
    }

    const debounceMs = Math.max(
      getAdaptiveDebounceMs(newFiles.length),
      VISIBLE_FILE_INDEXING_DEBOUNCE_MS
    );
    const timeoutId = setTimeout(() => {
      void indexVisibleFiles(newFiles);
    }, debounceMs);

    return () => clearTimeout(timeoutId);
  }, [
    visibleFiles,
    indexVisibleFiles,
    fileHandleMapRef,
    indexGetHandleRef,
    indexedFilesRef,
    inFlightRef,
    tokenCacheRef,
    isTokenCacheOperational,
    isTokenCachePersisted,
    fileHandleMapSize,
    indexVersion,
  ]);
}
