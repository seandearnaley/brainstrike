/**
 * React wiring for the per-row file metadata seam (BST-1207).
 *
 * Owns ONE `FileRowMetadataStore` for the lifetime of the mounting component
 * and connects it to the two places metadata actually lives:
 *
 * - Tokens and the size fallback come from the TokenCacheContext — the hot
 *   in-memory cache, warmed from PGlite `file_token_cache` by the existing
 *   preload/warm path. This hook never queries the database itself.
 * - The preferred size and the directory subtree enumeration come from the
 *   caller (the tree), so the store stays free of tree traversal.
 *
 * Invalidation has exactly two triggers, both existing channels:
 * the token cache's `cacheVersion` (a count landed) and
 * `FILE_EXPLORER_REFRESH_EVENT` (the on-disk tree changed). No polling, no new
 * event channel — see docs/agents/explorer-search-tapestry.md "EXPLORER TREE
 * LIVE REFRESH". Both trigger `invalidateAll`, which diffs per key and notifies
 * only the keys whose value actually moved, so a single count landing cannot
 * re-render an unrelated row.
 */

import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import { useEffect, useRef, useState } from 'react';
import { FILE_EXPLORER_REFRESH_EVENT } from '../shell/file-explorer-refresh-event';
import {
  createFileRowMetadataStore,
  type FileRowDirectorySubtree,
  type FileRowMetadataStore,
} from './file-row-metadata-store';
import { useOptionalTokenCacheContext } from './token-cache-context';

export interface UseFileRowMetadataStoreParams {
  /**
   * Enumerated subtree for a directory composite key, or `null` when the key is
   * not a directory. `isComplete` must mirror the tree's
   * `hasIncompleteDescendants` guard so rollups never sum a partial subtree.
   */
  getDirectorySubtree: (compositeKey: string) => FileRowDirectorySubtree | null;
  /** `IFileNode.size` for a file composite key, when the tree knows it. */
  getNodeSize: (compositeKey: string) => number | undefined;
}

export function useFileRowMetadataStore(
  params: UseFileRowMetadataStoreParams
): FileRowMetadataStore {
  const tokenCache = useOptionalTokenCacheContext();

  // Latest-value refs: the store's source closures are created once, so they
  // must read through refs rather than capture this render's props/context.
  const paramsRef = useRef(params);
  const tokenCacheRef = useRef(tokenCache);

  const [store] = useState<FileRowMetadataStore>(() =>
    createFileRowMetadataStore({
      getCachedSize: (compositeKey) => {
        const cache = tokenCacheRef.current;
        if (!cache?.isOperational) {
          return;
        }
        const { folderId, path } = decodeFileSelection(compositeKey);
        return cache.getFileSize(folderId, path);
      },
      getDirectorySubtree: (compositeKey) => paramsRef.current.getDirectorySubtree(compositeKey),
      getNodeSize: (compositeKey) => paramsRef.current.getNodeSize(compositeKey),
      getTokenCount: (compositeKey) => {
        const cache = tokenCacheRef.current;
        // A non-operational cache means "not counted yet", which the store
        // renders as `pending` — never as a zero.
        if (!cache?.isOperational) {
          return;
        }
        const { folderId, path } = decodeFileSelection(compositeKey);
        return cache.getTokenCount(folderId, path) ?? undefined;
      },
    })
  );

  // Sync the source refs AFTER commit, never during render: React can discard
  // render work, and a ref written in a thrown-away render would leak into the
  // store. Declared BEFORE the invalidation effects so those always observe
  // this commit's values.
  useEffect(() => {
    paramsRef.current = params;
    tokenCacheRef.current = tokenCache;
  });

  // A count landing bumps cacheVersion; the cache also goes from unusable to
  // usable without a version change, which turns every `pending` into a real
  // value. Both re-read every cached key and notify only the ones that moved.
  const cacheVersion = tokenCache?.cacheVersion ?? 0;
  const isCacheOperational = tokenCache?.isOperational ?? false;
  useEffect(() => {
    store.invalidateAll();
  }, [cacheVersion, isCacheOperational, store]);

  useEffect(() => {
    const handleRefreshEvent = (): void => {
      store.invalidateAll();
    };
    window.addEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefreshEvent);
    return () => {
      window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefreshEvent);
    };
  }, [store]);

  return store;
}
