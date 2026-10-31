/**
 * React wiring for the per-row file metadata seam (BST-1207).
 *
 * Owns ONE `FileRowMetadataStore` for the lifetime of the mounting component
 * and connects it to the two places metadata actually lives:
 *
 * - Tokens and the size fallback come from the TokenCacheContext — the hot
 *   in-memory cache, filled by the existing preload/warm path. This hook never
 *   queries a database itself.
 * - The preferred size and the directory subtree enumeration come from the
 *   caller (the tree), so the store stays free of tree traversal.
 *
 * INVALIDATION rides existing channels only — no polling, no new event channel
 * (docs/agents/explorer-search-context-map.md "EXPLORER TREE LIVE REFRESH"). There
 * are two paths, and the split is the whole point:
 *
 * 1. **Precise (the hot path).** The returned `onTokenResolved` must be passed
 *    to `useBackgroundTokenIndexerIntegration`. Every count the indexer resolves
 *    names its own composite key, so the store re-reads THAT key and the cached
 *    ancestor rollups only — O(affected keys) per arrival, whatever the tree
 *    size.
 * 2. **Reconciliation (the safety net).** Bulk hot-cache writes that name no
 *    key — `preloadFolder`, the warm-cache `updateHotCache` hydration, size
 *    backfills — only surface as a `cacheVersion` bump. Dropping that trigger
 *    would strand a reopened workspace's already-cached counts on `pending`
 *    forever, so it stays; but because `cacheVersion` is debounced at 50ms and
 *    therefore bumps ~20×/s during an index run (once per batch, alongside the
 *    precise calls above), the full pass is COALESCED behind a trailing timer
 *    with a `RECONCILE_METADATA_MAX_WAIT_MS` starvation bound. Sustained churn
 *    therefore forces a pass at least once per max-wait window. An operational
 *    transition and Explorer-relevant FILE_EXPLORER_REFRESH_EVENT reconcile
 *    immediately — both are one-shot and user-visible. A watcher event whose
 *    only evidence was a filtered Git boundary is deliberately a no-op here.
 */

import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import { useEffect, useMemo, useRef, useState } from 'react';
import { RECONCILE_METADATA_DEBOUNCE_MS, RECONCILE_METADATA_MAX_WAIT_MS } from '../constants';
import {
  FILE_EXPLORER_REFRESH_EVENT,
  type FileExplorerRefreshEvent,
} from '../shell/file-explorer-refresh-event';
import {
  createFileRowMetadataStore,
  type FileRowDirectorySubtree,
  type FileRowMetadataSources,
  type FileRowMetadataStore,
} from './file-row-metadata-store';
import { useOptionalTokenCacheContext } from './token-cache-context';

export interface UseFileRowMetadataStoreParams {
  /**
   * Enumerated subtree for a directory composite key. TOTAL by contract —
   * answer an `isComplete: false` subtree with `incompleteReason:
   * 'not-enumerated'` for anything you cannot enumerate rather than returning
   * nothing; `isComplete` must mirror the
   * tree's `hasIncompleteDescendants` guard so rollups never sum a partial
   * subtree.
   *
   * CONSUMER OBLIGATION: rollups computed from this are cached, and neither the
   * store nor this hook can see the tree change. Whenever your enumeration
   * shifts — expand, collapse, filter, tree refresh, root switch — call
   * `store.invalidateAll()` in the same commit. `use-file-tree-metadata-source`
   * does this off the row-model identity.
   */
  getDirectorySubtree: (compositeKey: string) => FileRowDirectorySubtree;
  /** `IFileNode.size` for a file composite key, when the tree knows it. */
  getNodeSize: (compositeKey: string) => number | undefined;
}

export interface UseFileRowMetadataStoreResult {
  /**
   * Call `store.invalidateAll()` yourself whenever the TREE SHAPE changes —
   * neither trigger below can observe expand/collapse, and cached directory
   * rollups would otherwise keep summing the old enumeration.
   */
  /**
   * Pass this straight to `useBackgroundTokenIndexerIntegration`'s
   * `onTokenResolved`. It is the precise invalidation path; without it every
   * count arrival degrades into a full re-scan of every rendered row.
   */
  onTokenResolved: (compositeKey: string) => void;
  store: FileRowMetadataStore;
}

/** Read accessors over one commit's params and token cache. */
function rowMetadataSources(
  params: UseFileRowMetadataStoreParams,
  tokenCache: ReturnType<typeof useOptionalTokenCacheContext>
): FileRowMetadataSources {
  return {
    getCachedSize: (compositeKey) => {
      if (!tokenCache?.isOperational) {
        return;
      }
      const { folderId, path } = decodeFileSelection(compositeKey);
      return tokenCache.getFileSize(folderId, path);
    },
    getDirectorySubtree: (compositeKey) => params.getDirectorySubtree(compositeKey),
    getNodeSize: (compositeKey) => params.getNodeSize(compositeKey),
    getTokenCount: (compositeKey) => {
      // A non-operational cache means "not counted yet", which the store
      // renders as `pending` — never as a zero.
      if (!tokenCache?.isOperational) {
        return;
      }
      const { folderId, path } = decodeFileSelection(compositeKey);
      return tokenCache.getTokenCount(folderId, path) ?? undefined;
    },
  };
}

export function useFileRowMetadataStore(
  params: UseFileRowMetadataStoreParams
): UseFileRowMetadataStoreResult {
  const tokenCache = useOptionalTokenCacheContext();

  const [store] = useState(() =>
    createFileRowMetadataStore(rowMetadataSources(params, tokenCache))
  );

  // Swap the sources AFTER commit, never during render: React can discard
  // render work, and sources from a thrown-away render would leak into the
  // store. Declared BEFORE the invalidation effects so those always observe
  // this commit's values.
  useEffect(() => {
    store.setSources(rowMetadataSources(params, tokenCache));
  });

  // Precise path. `handleFileIndexed` writes the hot cache before invoking this,
  // so the fresh count is already readable.
  const onTokenResolved = (compositeKey: string) => {
    store.invalidate([compositeKey]);
  };

  const reconcileTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstPendingReconcileAtRef = useRef<number | null>(null);
  const scheduleReconcile = useMemo(() => {
    const clearPendingTimeout = (): void => {
      if (reconcileTimeoutRef.current !== null) {
        clearTimeout(reconcileTimeoutRef.current);
        reconcileTimeoutRef.current = null;
      }
    };
    const cancel = (): void => {
      clearPendingTimeout();
      firstPendingReconcileAtRef.current = null;
    };
    return {
      cancel,
      clearPendingTimeout,
      /** Trailing-coalesced, with a max wait so continuous churn cannot starve. */
      schedule: (): void => {
        const now = Date.now();
        const firstPendingAt = firstPendingReconcileAtRef.current ?? now;
        firstPendingReconcileAtRef.current = firstPendingAt;
        clearPendingTimeout();
        const remainingMaxWaitMs = RECONCILE_METADATA_MAX_WAIT_MS - (now - firstPendingAt);
        const delayMs = Math.min(RECONCILE_METADATA_DEBOUNCE_MS, remainingMaxWaitMs);
        if (delayMs <= 0) {
          firstPendingReconcileAtRef.current = null;
          store.invalidateAll();
          return;
        }
        reconcileTimeoutRef.current = setTimeout(() => {
          reconcileTimeoutRef.current = null;
          firstPendingReconcileAtRef.current = null;
          store.invalidateAll();
        }, delayMs);
      },
    };
  }, [store]);

  const cacheVersion = tokenCache?.cacheVersion ?? 0;
  useEffect(() => {
    scheduleReconcile.schedule();
    // Dependency cleanup must clear only the trailing timer. Resetting the
    // first-pending timestamp here would restart the max-wait window on every
    // cacheVersion bump and recreate the starvation bug.
    return scheduleReconcile.clearPendingTimeout;
  }, [cacheVersion, scheduleReconcile]);

  // The cache going from unusable to usable turns every `pending` into a real
  // value at once, and can happen without a version bump. One-shot, so it does
  // not need coalescing — and a pending trailing pass would be redundant after.
  const isCacheOperational = tokenCache?.isOperational ?? false;
  useEffect(() => {
    scheduleReconcile.cancel();
    store.invalidateAll();
  }, [isCacheOperational, scheduleReconcile, store]);

  useEffect(() => {
    const handleRefreshEvent = (event: Event): void => {
      const { detail } = event as FileExplorerRefreshEvent;
      if (
        detail.source === 'watcher' &&
        detail.scope === 'incremental' &&
        detail.roots.every((root) => root.changes.length === 0)
      ) {
        return;
      }
      scheduleReconcile.cancel();
      store.invalidateAll();
    };
    window.addEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefreshEvent);
    return () => {
      window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefreshEvent);
    };
  }, [scheduleReconcile, store]);

  return { onTokenResolved, store };
}
