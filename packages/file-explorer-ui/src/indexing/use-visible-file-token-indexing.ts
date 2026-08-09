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
 * - **Cached-first.** Each involved folder's persistent cache is warmed once,
 *   then every key the cache can already answer is dropped (and marked indexed,
 *   so later passes skip the probe). Only genuine misses cost any work.
 * - **Throttled.** The debounce floor is `VISIBLE_FILE_INDEXING_DEBOUNCE_MS`,
 *   never faster than the selection trigger's adaptive debounce — the user is
 *   waiting on their selection, not on rows they scrolled past.
 *
 * State (`indexedFilesRef`, `inFlightRef`) is SHARED with the selection trigger
 * by design: whichever trigger reaches a file first, the other must not queue
 * it again.
 */

import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import { createLogger } from '@brainstrike/logging';
import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { getAdaptiveDebounceMs, VISIBLE_FILE_INDEXING_DEBOUNCE_MS } from '../constants';
import { normalizeSelectionPathForTokenCache } from './background-token-indexer-dispatch-helpers';
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
  tokenCacheRef,
  triggerIndexing,
  visibleFiles,
}: UseVisibleFileTokenIndexingParams): void {
  // Folder warms are memoized for this hook's lifetime. `folderId` is a durable
  // RootId, so a root switch cannot produce a stale hit, and the warm itself is
  // idempotent — anything written after it came from an index we dispatched,
  // which already wrote the hot cache.
  const [preloadedFolders] = useState<Set<string>>(() => new Set());

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
        if (preloadedFolders.has(folderId)) {
          continue;
        }
        warmups.push(
          cache.preloadFolder(folderId).then(() => {
            preloadedFolders.add(folderId);
          })
        );
      }
      await Promise.all(warmups);

      const uncachedKeys: string[] = [];
      for (const compositeKey of compositeKeys) {
        const { folderId, path } = decodeFileSelection(compositeKey);
        let normalizedFilePath: string;
        try {
          normalizedFilePath = normalizeSelectionPathForTokenCache(folderId, path);
        } catch {
          // Hand it to the dispatch planner, which classifies and logs the
          // unsafe path, rather than dropping it silently here.
          uncachedKeys.push(compositeKey);
          continue;
        }
        if (cache.getTokenCount(folderId, normalizedFilePath) === null) {
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
    [indexedFilesRef, preloadedFolders, tokenCacheRef, triggerIndexing]
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
    fileHandleMapSize,
    indexVersion,
  ]);
}
