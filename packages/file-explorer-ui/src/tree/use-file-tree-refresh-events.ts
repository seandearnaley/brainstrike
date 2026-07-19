/**
 * Per-provider bridge from FILE_EXPLORER_REFRESH_EVENT to the lazy file tree.
 *
 * Mounted once per FileTreeProvider (outer focused-root provider AND every
 * forest RootSection provider), so:
 *
 * - `source: 'manual'` + `scope: 'full'` → `refreshTree()` on every provider
 *   EXCEPT the panel's own refresh authority (the outer, non-nested provider —
 *   `skipManualFullEvents`): the toolbar Refresh button awaits that provider's
 *   refresh directly and only dispatches the event on success, so reacting
 *   here would enumerate the same root twice. Forest RootSection providers
 *   (nested) always react — this is what makes the Refresh button reach every
 *   forest root, including the focused root's VISIBLE section.
 * - `source: 'watcher'` + `scope: 'incremental'` → structural changes
 *   (added/removed) belonging to THIS provider's root are mapped to their
 *   parent directories; only parents currently LOADED in the normalized tree
 *   are re-enumerated (`refreshDirectory`), deduped per dispatch. Unloaded
 *   directories are skipped — they re-enumerate on expand anyway. Root-level
 *   membership changes reload the root via `refreshTree()` (the root is not a
 *   node), and that reload is AWAITED before any per-directory refresh so the
 *   root replacement can never clobber a concurrent child update. Pure
 *   `modified` changes are ignored: they don't alter tree membership, and
 *   content/DB freshness is the background indexer's job (it consumes the
 *   same event in workspace-collection-sync-provider).
 *
 * Root matching is durable-id-first: when this provider has a RootId (UUID),
 * only the event entry with that exact rootId matches — the path fallback is
 * reserved for legacy path-identified roots (two same-named web roots share a
 * path, so a path match across durable ids would refresh the wrong root).
 *
 * Upstream shaping keeps this cheap: main-process watchers batch at 150ms
 * (electron-watchers) and use-file-system-context debounces dispatches at
 * 300ms, so a build burst arrives as one event with many changes.
 */
import type { FileSystemChange } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { useEffect, useRef } from 'react';
import {
  FILE_EXPLORER_REFRESH_EVENT,
  type FileExplorerRefreshEvent,
  type FileExplorerRefreshRootDetail,
} from '../shell/file-explorer-refresh-event';
import type { NormalizedFileTreeState } from '../utils/normalized-file-tree';
import { getNormalizedNode } from '../utils/normalized-file-tree';
import type { FileTreeRefreshResult } from './use-lazy-file-tree';

const logger = createLogger('FileTreeRefreshEvents');

export interface UseFileTreeRefreshEventsParams {
  /** Reads the provider's CURRENT normalized tree (loaded-state lookups). */
  getNormalizedTree: () => NormalizedFileTreeState | null;
  refreshDirectory: (path: string) => Promise<void>;
  refreshTree: () => Promise<FileTreeRefreshResult>;
  /** Durable RootId (UUID) when known; null for legacy path-identified roots. */
  rootId: string | null;
  rootPath: string | null;
  /**
   * True for the panel's refresh authority (the outer, non-nested provider):
   * the toolbar Refresh awaits its refresh directly, so it must ignore
   * manual/full events. Forest RootSection providers pass false.
   */
  skipManualFullEvents: boolean;
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
  effectiveRootId: string,
  rootId: string | null,
  rootPath: string
): boolean {
  if (root.rootId === effectiveRootId) {
    return true;
  }
  // Path fallback ONLY for legacy roots without a durable id — same-named web
  // roots share a path, so a path match across durable ids is a wrong-root hit.
  return rootId === null && root.rootPath === rootPath;
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
    if (change.path === rootPath || parent === null || parent === rootPath) {
      refreshRoot = true;
      continue;
    }
    if (normalizedTree && getNormalizedNode(normalizedTree, parent)?.loadState === 'loaded') {
      parentsToRefresh.add(parent);
    }
  }

  return { parentsToRefresh, refreshRoot };
}

async function handleWatcherIncrementalRefresh(
  detail: FileExplorerRefreshEvent['detail'],
  current: UseFileTreeRefreshEventsParams,
  effectiveRootId: string,
  rootPath: string
): Promise<void> {
  const rootDetail = detail.roots.find((root) =>
    matchesRoot(root, effectiveRootId, current.rootId, rootPath)
  );
  if (!rootDetail) {
    return;
  }

  const { parentsToRefresh, refreshRoot } = collectStructuralRefreshTargets(
    rootDetail.changes,
    rootPath,
    current.getNormalizedTree()
  );

  // Sequence root before directories: a concurrent root replacement could
  // otherwise clobber a child re-enumeration mid-flight.
  if (refreshRoot) {
    await current.refreshTree();
  }
  for (const parent of parentsToRefresh) {
    // Re-check after a root reload — it may have reset this directory to
    // unloaded, in which case expand re-enumerates it anyway.
    const tree = current.getNormalizedTree();
    if (!(tree && getNormalizedNode(tree, parent)?.loadState === 'loaded')) {
      continue;
    }
    await current.refreshDirectory(parent);
  }
}

export function useFileTreeRefreshEvents({
  getNormalizedTree,
  refreshDirectory,
  refreshTree,
  rootId,
  rootPath,
  skipManualFullEvents,
}: UseFileTreeRefreshEventsParams): void {
  // Latest-value refs: the event listener must never restart on identity
  // churn of the tree callbacks (they are recreated every render).
  const paramsRef = useRef({
    getNormalizedTree,
    refreshDirectory,
    refreshTree,
    rootId,
    rootPath,
    skipManualFullEvents,
  });
  paramsRef.current = {
    getNormalizedTree,
    refreshDirectory,
    refreshTree,
    rootId,
    rootPath,
    skipManualFullEvents,
  };

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
        if (!current.skipManualFullEvents) {
          current.refreshTree().catch((error: unknown) => {
            logger.warn('Manual full tree refresh failed', {
              error: error instanceof Error ? error.message : String(error),
              rootPath: currentRootPath,
            });
          });
        }
        return;
      }
      if (detail.source === 'watcher' && detail.scope === 'incremental') {
        handleWatcherIncrementalRefresh(detail, current, effectiveRootId, currentRootPath).catch(
          (error: unknown) => {
            logger.warn('Watcher-driven tree refresh failed', {
              error: error instanceof Error ? error.message : String(error),
              rootPath: currentRootPath,
            });
          }
        );
      }
    };

    window.addEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefreshEvent);
    return () => {
      window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefreshEvent);
    };
  }, []);
}
