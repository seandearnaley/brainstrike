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
 * - `source: 'watcher'` + `scope: 'full'` → OVERFLOW recovery: the watcher may
 *   have MISSED events for the named root(s) (FileSystemObserver `unknown`
 *   record — see use-file-system-context's overflow dispatch), so the
 *   incremental stream is no longer trustworthy. Fully re-enumerate this
 *   provider's root via `refreshTree()` when it is named. Deliberately NOT
 *   gated by `skipManualFullEvents`: unlike the manual Refresh button, nothing
 *   re-enumerates an overflow directly, so the authority (outer) provider must
 *   react too — a single-root workspace has no forest RootSection and would
 *   otherwise never reload on overflow.
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

import { useEventCallback } from '@brainstrike/hooks';
import { createLogger } from '@brainstrike/logging';
import type { FileSystemChange } from '@brainstrike/types';
import { useEffect, useState } from 'react';
import {
  FILE_EXPLORER_REFRESH_EVENT,
  type FileExplorerRefreshEvent,
  type FileExplorerRefreshRootDetail,
} from '../shell/file-explorer-refresh-event';
import type { NormalizedFileTreeState } from '../utils/normalized-file-tree';
import { getNormalizedNode } from '../utils/normalized-file-tree';
import type { FileTreeDirectorySnapshot, FileTreeRefreshResult } from './use-lazy-file-tree';

const logger = createLogger('FileTreeRefreshEvents');

export interface UseFileTreeRefreshEventsParams {
  /** Reads the provider's CURRENT normalized tree (loaded-state lookups). */
  getNormalizedTree: () => NormalizedFileTreeState | null;
  /** Current selected-path ancestor directories for this provider, parent-first. */
  getSelectionAncestorDirectories: () => readonly string[];
  reconcileSelectionWithDirectorySnapshots: (
    snapshots: readonly FileTreeDirectorySnapshot[]
  ) => void;
  refreshDirectory: (path: string) => Promise<FileTreeDirectorySnapshot | null>;
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

export interface SelectionAwareRootRefreshParams {
  getNormalizedTree: () => NormalizedFileTreeState | null;
  getSelectionAncestorDirectories: () => readonly string[];
  reconcileSelectionWithDirectorySnapshots: (
    snapshots: readonly FileTreeDirectorySnapshot[]
  ) => void;
  refreshDirectory: (path: string) => Promise<FileTreeDirectorySnapshot | null>;
  refreshTree: () => Promise<FileTreeRefreshResult>;
}

/** Strip the last path segment; handles both posix and windows separators. */
function parentPathOf(changePath: string): string | null {
  const lastSeparator = Math.max(changePath.lastIndexOf('/'), changePath.lastIndexOf('\\'));
  if (lastSeparator <= 0) {
    return null;
  }
  if (lastSeparator === 2 && /^[A-Za-z]:[\\/]$/u.test(changePath.slice(0, 3))) {
    return changePath.slice(0, 3);
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

function directoryPathDepth(path: string): number {
  return path.replace(/\\/gu, '/').split('/').filter(Boolean).length;
}

function orderDirectoryPaths(paths: readonly string[]): string[] {
  return Array.from(new Set(paths)).sort((left, right) => {
    const depthDifference = directoryPathDepth(left) - directoryPathDepth(right);
    if (depthDifference !== 0) {
      return depthDifference;
    }
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  });
}

async function refreshAuthoritativeDirectories(
  current: SelectionAwareRootRefreshParams,
  directoryPaths: readonly string[]
): Promise<void> {
  const snapshots: FileTreeDirectorySnapshot[] = [];
  for (const directoryPath of orderDirectoryPaths(directoryPaths)) {
    // A shallow root replacement resets surviving directories to unloaded.
    // Existence + directory type are authoritative enough to force a read;
    // removed/retyped paths are skipped instead of resurrected.
    const tree = current.getNormalizedTree();
    const node = tree ? getNormalizedNode(tree, directoryPath) : undefined;
    if (node?.type !== 'directory') {
      continue;
    }
    // Intentional serialization: parent refreshes materialize the handles for
    // their selected descendants, and every replacement shares one tree.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const snapshot = await current.refreshDirectory(directoryPath);
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }
  if (snapshots.length > 0) {
    current.reconcileSelectionWithDirectorySnapshots(snapshots);
  }
}

async function refreshRootAndDirectories(
  current: SelectionAwareRootRefreshParams,
  additionalDirectoryPaths: readonly string[] = []
): Promise<FileTreeRefreshResult> {
  const outcome = await current.refreshTree();
  if (outcome.status !== 'completed') {
    return outcome;
  }
  await refreshAuthoritativeDirectories(current, [
    ...current.getSelectionAncestorDirectories(),
    ...additionalDirectoryPaths,
  ]);
  return outcome;
}

/**
 * Provider-level manual refresh authority: shallow root replacement followed
 * by bounded selected-path ancestor revalidation.
 */
export async function refreshTreeWithSelectionRevalidation(
  current: SelectionAwareRootRefreshParams
): Promise<FileTreeRefreshResult> {
  return refreshRootAndDirectories(current);
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
  // otherwise clobber a child re-enumeration mid-flight. The same batch also
  // revalidates selected ancestors that a shallow root listing cannot prove.
  if (refreshRoot) {
    await refreshRootAndDirectories(current, Array.from(parentsToRefresh));
    return;
  }
  await refreshAuthoritativeDirectories(current, Array.from(parentsToRefresh));
}

/**
 * OVERFLOW recovery (watcher + full): the watcher may have missed events for
 * the named root(s), so the incremental stream is untrustworthy — fully
 * re-enumerate this provider's root when named. Deliberately NOT gated by
 * `skipManualFullEvents` (see hook JSDoc: nothing refreshes an overflow
 * directly, so the outer authority provider must react too).
 */
async function handleWatcherOverflowRefresh(
  detail: FileExplorerRefreshEvent['detail'],
  current: UseFileTreeRefreshEventsParams,
  effectiveRootId: string,
  rootPath: string
): Promise<void> {
  const overflowsThisRoot = detail.roots.some((root) =>
    matchesRoot(root, effectiveRootId, current.rootId, rootPath)
  );
  if (!overflowsThisRoot) {
    return;
  }
  await refreshRootAndDirectories(current);
}

async function runRefreshWork(
  work: () => Promise<void>,
  warningMessage: string,
  rootPath: string
): Promise<void> {
  try {
    await work();
  } catch (error) {
    logger.warn(warningMessage, {
      error: error instanceof Error ? error.message : String(error),
      rootPath,
    });
  }
}

async function processRefreshEventDetail(
  detail: FileExplorerRefreshEvent['detail'],
  current: UseFileTreeRefreshEventsParams
): Promise<void> {
  const currentRootPath = current.rootPath;
  if (currentRootPath === null) {
    return;
  }
  const effectiveRootId = current.rootId ?? currentRootPath;

  if (detail.source === 'manual' && detail.scope === 'full') {
    if (current.skipManualFullEvents) {
      return;
    }
    await runRefreshWork(
      async () => {
        await refreshTreeWithSelectionRevalidation(current);
      },
      'Manual full tree refresh failed',
      currentRootPath
    );
    return;
  }
  if (detail.source === 'watcher' && detail.scope === 'incremental') {
    await runRefreshWork(
      () => handleWatcherIncrementalRefresh(detail, current, effectiveRootId, currentRootPath),
      'Watcher-driven tree refresh failed',
      currentRootPath
    );
    return;
  }
  if (detail.source === 'watcher' && detail.scope === 'full') {
    await runRefreshWork(
      () => handleWatcherOverflowRefresh(detail, current, effectiveRootId, currentRootPath),
      'Watcher overflow tree refresh failed',
      currentRootPath
    );
  }
}

export function useFileTreeRefreshEvents({
  getNormalizedTree,
  getSelectionAncestorDirectories,
  reconcileSelectionWithDirectorySnapshots,
  refreshDirectory,
  refreshTree,
  rootId,
  rootPath,
  skipManualFullEvents,
}: UseFileTreeRefreshEventsParams): void {
  const [refreshQueueRef] = useState<{ current: Promise<void> }>(() => ({
    current: Promise.resolve(),
  }));

  // Commit-phase latest-value dispatcher: queued events execute against the
  // provider identity that is current when their turn begins. A same-path
  // rootId switch therefore cannot make an old event refresh the new root.
  const processRefreshEvent = useEventCallback(
    async (detail: FileExplorerRefreshEvent['detail']): Promise<void> => {
      const current: UseFileTreeRefreshEventsParams = {
        getNormalizedTree,
        getSelectionAncestorDirectories,
        reconcileSelectionWithDirectorySnapshots,
        refreshDirectory,
        refreshTree,
        rootId,
        rootPath,
        skipManualFullEvents,
      };
      await processRefreshEventDetail(detail, current);
    }
  );

  useEffect(() => {
    const handleRefreshEvent = (event: Event): void => {
      const { detail } = event as FileExplorerRefreshEvent;
      const runQueuedEvent = (): Promise<void> => processRefreshEvent(detail);
      refreshQueueRef.current = refreshQueueRef.current
        .then(runQueuedEvent, runQueuedEvent)
        .catch((error: unknown) => {
          logger.warn('Unexpected file tree refresh queue failure', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    };

    window.addEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefreshEvent);
    return () => {
      window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefreshEvent);
    };
  }, [processRefreshEvent, refreshQueueRef]);
}
