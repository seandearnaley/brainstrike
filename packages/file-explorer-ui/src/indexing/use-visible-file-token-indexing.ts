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
 * - **Capped.** The visible set is every file under an expanded directory, not
 *   the viewport, so expanding one large directory can surface thousands of
 *   uncached files at once — each of which costs a full-content read (IPC on
 *   desktop). A pass dispatches at most `VISIBLE_FILE_INDEXING_MAX_PER_PASS`
 *   keys and re-arms itself for the remainder, but ONLY when the previous pass
 *   made progress, so a set that can never be consumed (every key parked for a
 *   missing handle) cannot spin.
 * - **Throttled.** The `VISIBLE_FILE_INDEXING_DEBOUNCE_MS` floor is 2× the
 *   selection trigger's longest adaptive delay, so visible work sits behind
 *   selection work for every batch size except the degenerate case where a huge
 *   selection and a tiny visible set land in the same window. The two debounces
 *   are independent — this is a strong bias, not an ordering guarantee.
 *
 * State (`indexedFilesRef`, `inFlightRef`, `preloadedFoldersRef`) is SHARED
 * with the selection trigger by design: whichever trigger reaches a file first,
 * the other must not queue it again, and the parent owns the single reset point
 * for all of it (root change and tree clear).
 */

import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import { createLogger } from '@brainstrike/logging';
import type { MutableRefObject } from 'react';
import { useEffect, useState } from 'react';
import {
  VISIBLE_FILE_INDEXING_DEBOUNCE_MS,
  VISIBLE_FILE_INDEXING_MAX_PER_PASS,
} from '../constants';
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
  /**
   * Parent-owned memo of folders already warmed for THIS trigger. A stable Set
   * instance (not a ref) — the parent clears it in place on root change and
   * tree clear.
   */
  preloadedFolders: Set<string>;
  tokenCacheRef: MutableRefObject<TokenCacheContextValue | null>;
  /** The selection trigger's dispatch path, reused verbatim. */
  triggerIndexing: (compositeKeys: string[]) => Promise<void>;
  /** Composite keys of files visible in the tree, or undefined when unused. */
  visibleFiles: ReadonlySet<string> | undefined;
}

export interface ShouldRearmVisibleFileIndexingParams {
  cancelled: boolean;
  candidateCount: number;
  remainingCount: number;
}

/** Pure decision seam for the async effect's post-dispatch continuation. */
export function shouldRearmVisibleFileIndexing({
  cancelled,
  candidateCount,
  remainingCount,
}: ShouldRearmVisibleFileIndexingParams): boolean {
  return !cancelled && remainingCount > 0 && remainingCount < candidateCount;
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
  preloadedFolders,
  tokenCacheRef,
  triggerIndexing,
  visibleFiles,
}: UseVisibleFileTokenIndexingParams): void {
  // Re-arm counter for the capped pass. State, not a ref: consuming a batch
  // has to schedule the NEXT effect run, and nothing else in the deps moves
  // when a batch completes.
  const [passCursor, setPassCursor] = useState(0);

  const indexVisibleFiles = async (compositeKeys: readonly string[]): Promise<void> => {
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
          // Only remember a warm that could actually have read the DB. Before
          // persistence is up `preloadFolder` reads nothing, and memoizing
          // that would defeat cached-first for the whole session.
          if (tokenCacheRef.current?.isPersisted) {
            preloadedFolders.add(folderId);
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
  };

  useEffect(() => {
    if (!visibleFiles || visibleFiles.size === 0) {
      return;
    }
    const hasHandleSource = Boolean(indexGetHandleRef.current) || fileHandleMapRef.current.size > 0;
    if (!(tokenCacheRef.current?.isOperational && hasHandleSource)) {
      return;
    }

    const isUnconsumed = (compositeKey: string): boolean =>
      !(indexedFilesRef.current.has(compositeKey) || inFlightRef.current.has(compositeKey));
    const candidates = Array.from(visibleFiles).filter(isUnconsumed);
    if (candidates.length === 0) {
      return;
    }

    const batch = candidates.slice(0, VISIBLE_FILE_INDEXING_MAX_PER_PASS);
    let cancelled = false;
    const timeoutId = setTimeout(() => {
      void indexVisibleFiles(batch)
        .then(() => {
          const remaining = Array.from(visibleFiles).filter(isUnconsumed).length;
          // Re-arm on PROGRESS only. A pass that consumed nothing — every key
          // parked for a missing handle, say — must not reschedule itself.
          // `cancelled` means cleanup ran for any reason, including dependency
          // replacement as well as unmount; the replacement effect owns any
          // next pass and this stale continuation must not update its cursor.
          if (
            shouldRearmVisibleFileIndexing({
              cancelled,
              candidateCount: candidates.length,
              remainingCount: remaining,
            })
          ) {
            setPassCursor((cursor) => cursor + 1);
          }
        })
        .catch((error: unknown) => {
          // A permanent worker/DB failure must be visible and must not create
          // an unbounded retry loop. A later dependency change can retry the
          // still-unconsumed keys through a fresh effect.
          logger.error('Visible-file indexing pass failed; automatic re-arm suppressed', {
            error,
          });
        });
    }, VISIBLE_FILE_INDEXING_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [
    visibleFiles,
    indexVisibleFiles,
    passCursor,
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
