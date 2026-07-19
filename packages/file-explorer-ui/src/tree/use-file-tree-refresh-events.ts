/**
 * Per-provider bridge from FILE_EXPLORER_REFRESH_EVENT to the lazy file tree.
 *
 * Mounted once per FileTreeProvider (outer focused-root provider AND every
 * forest RootSection provider), so:
 *
 * - `source: 'manual'` + `scope: 'full'` → `refreshTree()` on EVERY provider.
 *   This is what makes the toolbar Refresh button reach forest roots — before
 *   this hook only the focused root's provider was refreshed. Concurrent
 *   triggers for the same root coalesce in the lazy tree's in-flight
 *   root-load dedup, so the panel's own awaited refresh never doubles work.
 * - `source: 'watcher'` + `scope: 'incremental'` → structural changes
 *   (added/removed) belonging to THIS provider's root are mapped to their
 *   parent directories; only parents currently LOADED in the normalized tree
 *   are re-enumerated (`refreshDirectory`), deduped per dispatch. Unloaded
 *   directories are skipped — they re-enumerate on expand anyway. Root-level
 *   membership changes fall back to `refreshTree()` (the root is not a node).
 *   Pure `modified` changes are ignored: they don't alter tree membership,
 *   and content/DB freshness is the background indexer's job (it consumes the
 *   same event in workspace-collection-sync-provider).
 *
 * Upstream shaping keeps this cheap: main-process watchers batch at 150ms
 * (electron-watchers) and use-file-system-context debounces dispatches at
 * 300ms, so a build burst arrives as one event with many changes.
 */
import type { FileSystemChange } from '@brainstrike/types';
import { useEffect, useRef } from 'react';
import {
  FILE_EXPLORER_REFRESH_EVENT,
  type FileExplorerRefreshEvent,
  type FileExplorerRefreshRootDetail,
} from '../shell/file-explorer-refresh-event';
import type { NormalizedFileTreeState } from '../utils/normalized-file-tree';
import { getNormalizedNode } from '../utils/normalized-file-tree';
import type { FileTreeRefreshResult } from './use-lazy-file-tree';

export interface UseFileTreeRefreshEventsParams {
  /** Reads the provider's CURRENT normalized tree (loaded-state lookups). */
  getNormalizedTree: () => NormalizedFileTreeState | null;
  refreshDirectory: (path: string) => Promise<void>;
  refreshTree: () => Promise<FileTreeRefreshResult>;
  /** Durable RootId (UUID) when known; falls back to the root path. */
  rootId: string | null;
  rootPath: string | null;
}

/** Strip the last path segment; handles both posix and windows separators. */
function parentPathOf(changePath: string): string | null {
  const lastSeparator = Math.max(changePath.lastIndexOf('/'), changePath.lastIndexOf('\\'));
  if (lastSeparator <= 0) {
    return null;
  }
  return changePath.slice(0, lastSeparator);
}

function matchesRoot(
  root: FileExplorerRefreshRootDetail,
  rootId: string,
  rootPath: string
): boolean {
  return root.rootId === rootId || root.rootPath === rootPath;
}

function isAlreadyRefreshedByDispatcher(
  refreshedRootIds: readonly string[] | undefined,
  rootId: string,
  rootPath: string
): boolean {
  return (
    refreshedRootIds?.some((refreshedId) => refreshedId === rootId || refreshedId === rootPath) ??
    false
  );
}

interface StructuralRefreshTargets {
  /** Loaded parent directories to re-enumerate, deduped. */
  parentsToRefresh: ReadonlySet<string>;
  /** True when a root-level membership change requires a root reload. */
  refreshRoot: boolean;
}

function collectStructuralRefreshTargets(
  changes: readonly FileSystemChange[],
  rootPath: string,
  normalizedTree: NormalizedFileTreeState | null
): StructuralRefreshTargets {
  let refreshRoot = false;
  const parentsToRefresh = new Set<string>();

  for (const change of changes) {
    // Membership changes only: 'modified' never alters the tree shape.
    if (change.type !== 'added' && change.type !== 'removed') {
      continue;
    }
    const parent = parentPathOf(change.path);
    if (parent === null || parent === rootPath) {
      refreshRoot = true;
      continue;
    }
    if (normalizedTree && getNormalizedNode(normalizedTree, parent)?.loadState === 'loaded') {
      parentsToRefresh.add(parent);
    }
  }

  return { parentsToRefresh, refreshRoot };
}

function handleManualFullRefresh(
  detail: FileExplorerRefreshEvent['detail'],
  current: UseFileTreeRefreshEventsParams,
  effectiveRootId: string,
  rootPath: string
): void {
  // The dispatcher (panel refresh button) already refreshed the focused
  // root itself — skip it instead of enumerating the same root twice.
  if (!isAlreadyRefreshedByDispatcher(detail.refreshedRootIds, effectiveRootId, rootPath)) {
    void current.refreshTree();
  }
}

function handleWatcherIncrementalRefresh(
  detail: FileExplorerRefreshEvent['detail'],
  current: UseFileTreeRefreshEventsParams,
  effectiveRootId: string,
  rootPath: string
): void {
  const rootDetail = detail.roots.find((root) => matchesRoot(root, effectiveRootId, rootPath));
  if (!rootDetail) {
    return;
  }

  const { parentsToRefresh, refreshRoot } = collectStructuralRefreshTargets(
    rootDetail.changes,
    rootPath,
    current.getNormalizedTree()
  );

  if (refreshRoot) {
    void current.refreshTree();
  }
  for (const parent of parentsToRefresh) {
    void current.refreshDirectory(parent);
  }
}

export function useFileTreeRefreshEvents({
  getNormalizedTree,
  refreshDirectory,
  refreshTree,
  rootId,
  rootPath,
}: UseFileTreeRefreshEventsParams): void {
  // Latest-value refs: the event listener must never restart on identity
  // churn of the tree callbacks (they are recreated every render).
  const paramsRef = useRef({ getNormalizedTree, refreshDirectory, refreshTree, rootId, rootPath });
  paramsRef.current = { getNormalizedTree, refreshDirectory, refreshTree, rootId, rootPath };

  useEffect(() => {
    const handleRefreshEvent = (event: Event): void => {
      const { detail } = event as FileExplorerRefreshEvent;
      const current = paramsRef.current;
      const currentRootPath = current.rootPath;
      if (currentRootPath === null) {
        return;
      }
      const effectiveRootId = current.rootId ?? currentRootPath;

      if (detail.source === 'manual' && detail.scope === 'full') {
        handleManualFullRefresh(detail, current, effectiveRootId, currentRootPath);
        return;
      }
      if (detail.source === 'watcher' && detail.scope === 'incremental') {
        handleWatcherIncrementalRefresh(detail, current, effectiveRootId, currentRootPath);
      }
    };

    window.addEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefreshEvent);
    return () => {
      window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefreshEvent);
    };
  }, []);
}
