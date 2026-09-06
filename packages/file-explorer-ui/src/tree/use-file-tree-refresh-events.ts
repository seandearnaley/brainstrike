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
 *   parent directories; parents currently LOADED, LOADING, or ERROR in the
 *   normalized tree are re-enumerated (`refreshDirectory`), deduped per
 *   dispatch. Loading retains the post-I/O invalidation, error gets a
 *   watcher-proven retry, and genuinely unloaded nonselected directories are
 *   skipped — they re-enumerate on expand anyway. An unloaded exact changed
 *   parent that contains selected descendants is the bounded exception: it is
 *   re-enumerated so removal evidence cannot leave a ghost selection. Root-level
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
 * - Consecutive direct/manual/watcher full requests share at most one pending
 *   physical refresh. Once the active read begins, later requests retain one
 *   trailing authoritative read; incremental events split coalescing groups.
 *   Every direct caller receives the exact shared result.
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
import { runWithConcurrency } from '../utils/concurrency';
import type { NormalizedFileTreeState } from '../utils/normalized-file-tree';
import { getNormalizedNode } from '../utils/normalized-file-tree';
import type { FileTreeDirectorySnapshot, FileTreeRefreshResult } from './use-lazy-file-tree';

const logger = createLogger('FileTreeRefreshEvents');
export const MAX_CONCURRENT_SELECTION_REVALIDATION_READS = 5;
type RefreshLifecycleGuard = () => boolean;
const isAlwaysActive: RefreshLifecycleGuard = () => true;
interface RefreshQueueRef {
  current: Promise<void>;
}
interface PendingFullRefresh {
  key: string;
  result: Promise<FileTreeRefreshResult>;
}
interface PendingFullRefreshRef {
  current: PendingFullRefresh | null;
}

export interface UseFileTreeRefreshEventsParams {
  /** Reads the provider's CURRENT normalized tree (loaded-state lookups). */
  getNormalizedTree: () => NormalizedFileTreeState | null;
  /** Current selected-path ancestor directories for this provider, parent-first. */
  getSelectionAncestorDirectories: () => readonly string[];
  /** Monotonic effective-projection revision used to reject stale snapshot batches. */
  getSelectionProjectionRevision: () => number;
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
  getSelectionProjectionRevision: () => number;
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
  /** Every non-root structural parent named by the event, loaded or not. */
  changedParents: ReadonlySet<string>;
  /** Authoritative/loading/error parent directories to re-enumerate, deduped. */
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
  const changedParents = new Set<string>();
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
    changedParents.add(parent);
    const loadState = normalizedTree ? getNormalizedNode(normalizedTree, parent)?.loadState : null;
    if (loadState === 'loaded' || loadState === 'loading' || loadState === 'error') {
      parentsToRefresh.add(parent);
    }
  }

  return { changedParents, parentsToRefresh, refreshRoot };
}

function normalizePathForComparison(path: string, caseInsensitive: boolean): string {
  const normalized = path.replace(/\\/gu, '/');
  const withoutTrailingSlash =
    normalized.length > 1 && !/^[A-Za-z]:\/$/u.test(normalized)
      ? normalized.replace(/\/+$/u, '')
      : normalized;
  return caseInsensitive ? withoutTrailingSlash.toLowerCase() : withoutTrailingSlash;
}

function usesCaseInsensitivePaths(rootPath: string): boolean {
  const normalizedRootPath = rootPath.replace(/\\/gu, '/');
  return /^[A-Za-z]:\//u.test(normalizedRootPath) || normalizedRootPath.startsWith('//');
}

/**
 * Intersect exact changed parents with selected-path ancestors. This preserves
 * the unloaded-directory fast path for unselected changes while making a
 * collapsed selected parent authoritative enough to disprove stale files.
 */
function getChangedSelectedParentPaths(
  current: UseFileTreeRefreshEventsParams,
  changedParents: ReadonlySet<string>,
  rootPath: string,
  normalizedTree: NormalizedFileTreeState | null
): string[] {
  if (!(normalizedTree && changedParents.size > 0)) {
    return [];
  }
  const caseInsensitive = usesCaseInsensitivePaths(rootPath);
  const selectedAncestorsByComparisonPath = new Map<string, string[]>();
  for (const ancestorPath of current.getSelectionAncestorDirectories()) {
    const comparisonPath = normalizePathForComparison(ancestorPath, caseInsensitive);
    const presentations = selectedAncestorsByComparisonPath.get(comparisonPath);
    if (presentations) {
      presentations.push(ancestorPath);
    } else {
      selectedAncestorsByComparisonPath.set(comparisonPath, [ancestorPath]);
    }
  }

  const selectedChangedParents: string[] = [];
  let missingSelectedParentCount = 0;
  for (const changedParent of changedParents) {
    const comparisonPath = normalizePathForComparison(changedParent, caseInsensitive);
    const selectedPresentations = selectedAncestorsByComparisonPath.get(comparisonPath);
    if (!selectedPresentations) {
      continue;
    }
    const treePath = [...selectedPresentations, changedParent].find(
      (candidatePath) => getNormalizedNode(normalizedTree, candidatePath)?.type === 'directory'
    );
    if (treePath) {
      selectedChangedParents.push(treePath);
    } else {
      missingSelectedParentCount += 1;
    }
  }
  if (missingSelectedParentCount > 0) {
    logger.warn('Selected changed parents were absent from the normalized tree', {
      missingParentCount: missingSelectedParentCount,
    });
  }
  return selectedChangedParents;
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

function groupDirectoryPathsByDepth(paths: readonly string[]): string[][] {
  const groups: string[][] = [];
  let currentDepth = -1;
  for (const path of orderDirectoryPaths(paths)) {
    const depth = directoryPathDepth(path);
    if (depth !== currentDepth) {
      groups.push([]);
      currentDepth = depth;
    }
    groups.at(-1)?.push(path);
  }
  return groups;
}

function enqueueRefreshWork<TResult>(
  queueRef: RefreshQueueRef,
  work: () => Promise<TResult>
): Promise<TResult> {
  const result = queueRef.current.then(work, work);
  queueRef.current = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function enqueueOrdinaryRefreshWork<TResult>(
  queueRef: RefreshQueueRef,
  pendingFullRefreshRef: PendingFullRefreshRef,
  work: () => Promise<TResult>
): Promise<TResult> {
  // An incremental event is a mutation boundary. Full refreshes on either
  // side must remain distinct and in FIFO order.
  pendingFullRefreshRef.current = null;
  return enqueueRefreshWork(queueRef, work);
}

function enqueueCoalescedFullRefresh(
  queueRef: RefreshQueueRef,
  pendingFullRefreshRef: PendingFullRefreshRef,
  key: string,
  work: () => Promise<FileTreeRefreshResult>
): Promise<FileTreeRefreshResult> {
  const pending = pendingFullRefreshRef.current;
  if (pending?.key === key) {
    return pending.result;
  }

  let record: PendingFullRefresh | null = null;
  const result = enqueueRefreshWork(queueRef, async () => {
    if (record && pendingFullRefreshRef.current === record) {
      // Once physical I/O begins, a later full signal may represent a later
      // mutation and therefore owns one trailing authoritative refresh.
      pendingFullRefreshRef.current = null;
    }
    return work();
  });
  record = { key, result };
  pendingFullRefreshRef.current = record;
  return result;
}

function createFullRefreshKey(rootId: string | null, rootPath: string | null): string {
  return JSON.stringify([rootId, rootPath]);
}

async function refreshAuthoritativeDirectories(
  current: SelectionAwareRootRefreshParams,
  directoryPaths: readonly string[],
  isActive: RefreshLifecycleGuard = isAlwaysActive
): Promise<void> {
  const selectionProjectionRevision = current.getSelectionProjectionRevision();
  const snapshots: FileTreeDirectorySnapshot[] = [];
  for (const depthGroup of groupDirectoryPathsByDepth(directoryPaths)) {
    // Depths remain serialized so parents materialize descendant handles first.
    // Peers are independent and use the same finite I/O bound as worker-backed
    // directory loading; no path is capped or dropped.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const groupSnapshots = await runWithConcurrency(
      depthGroup,
      MAX_CONCURRENT_SELECTION_REVALIDATION_READS,
      async (directoryPath): Promise<FileTreeDirectorySnapshot | null> => {
        if (!isActive()) {
          return null;
        }
        // A shallow root replacement resets surviving directories to unloaded.
        // Existence + directory type are authoritative enough to force a read;
        // removed/retyped paths are skipped instead of resurrected.
        const tree = current.getNormalizedTree();
        const node = tree ? getNormalizedNode(tree, directoryPath) : undefined;
        if (node?.type !== 'directory') {
          return null;
        }
        return current.refreshDirectory(directoryPath);
      }
    );
    if (!isActive()) {
      return;
    }
    if (current.getSelectionProjectionRevision() !== selectionProjectionRevision) {
      logger.debug(
        'Skipped stale directory snapshot reconciliation after selection projection changed',
        { directoryCount: directoryPaths.length }
      );
      return;
    }
    for (const snapshot of groupSnapshots) {
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }
  }
  if (isActive() && snapshots.length > 0) {
    current.reconcileSelectionWithDirectorySnapshots(snapshots);
  }
}

async function refreshRootAndDirectories(
  current: SelectionAwareRootRefreshParams,
  additionalDirectoryPaths: readonly string[] = [],
  isActive: RefreshLifecycleGuard = isAlwaysActive
): Promise<FileTreeRefreshResult> {
  if (!isActive()) {
    return { status: 'cancelled' };
  }
  const outcome = await current.refreshTree();
  if (!isActive()) {
    return { status: 'cancelled' };
  }
  if (outcome.status !== 'completed') {
    return outcome;
  }
  await refreshAuthoritativeDirectories(
    current,
    [...current.getSelectionAncestorDirectories(), ...additionalDirectoryPaths],
    isActive
  );
  if (!isActive()) {
    return { status: 'cancelled' };
  }
  return outcome;
}

/**
 * Provider-level manual refresh authority: shallow root replacement followed
 * by bounded selected-path ancestor revalidation.
 */
export async function refreshTreeWithSelectionRevalidation(
  current: SelectionAwareRootRefreshParams,
  isActive: RefreshLifecycleGuard = isAlwaysActive
): Promise<FileTreeRefreshResult> {
  return refreshRootAndDirectories(current, [], isActive);
}

async function handleWatcherIncrementalRefresh(
  detail: FileExplorerRefreshEvent['detail'],
  current: UseFileTreeRefreshEventsParams,
  effectiveRootId: string,
  rootPath: string,
  isActive: RefreshLifecycleGuard
): Promise<void> {
  if (!isActive()) {
    return;
  }
  const rootDetail = detail.roots.find((root) =>
    matchesRoot(root, effectiveRootId, current.rootId, rootPath)
  );
  if (!rootDetail) {
    return;
  }

  const normalizedTree = current.getNormalizedTree();
  const { changedParents, parentsToRefresh, refreshRoot } = collectStructuralRefreshTargets(
    rootDetail.changes,
    rootPath,
    normalizedTree
  );

  // Sequence root before directories: a concurrent root replacement could
  // otherwise clobber a child re-enumeration mid-flight. The same batch also
  // revalidates selected ancestors that a shallow root listing cannot prove.
  if (refreshRoot) {
    await refreshRootAndDirectories(current, Array.from(parentsToRefresh), isActive);
    return;
  }
  const selectedChangedParents = getChangedSelectedParentPaths(
    current,
    changedParents,
    rootPath,
    normalizedTree
  );
  await refreshAuthoritativeDirectories(
    current,
    [...parentsToRefresh, ...selectedChangedParents],
    isActive
  );
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
  current: UseFileTreeRefreshEventsParams,
  isActive: RefreshLifecycleGuard
): Promise<void> {
  if (!isActive()) {
    return;
  }
  const currentRootPath = current.rootPath;
  if (currentRootPath === null) {
    return;
  }
  const effectiveRootId = current.rootId ?? currentRootPath;

  if (detail.source === 'watcher' && detail.scope === 'incremental') {
    await runRefreshWork(
      () =>
        handleWatcherIncrementalRefresh(
          detail,
          current,
          effectiveRootId,
          currentRootPath,
          isActive
        ),
      'Watcher-driven tree refresh failed',
      currentRootPath
    );
  }
}

function reportFullRefreshFailure(
  result: Promise<FileTreeRefreshResult>,
  warningMessage: string,
  rootPath: string
): void {
  void result.catch((error: unknown) => {
    logger.warn(warningMessage, {
      error: error instanceof Error ? error.message : String(error),
      rootPath,
    });
  });
}

export function useFileTreeRefreshEvents({
  getNormalizedTree,
  getSelectionAncestorDirectories,
  getSelectionProjectionRevision,
  reconcileSelectionWithDirectorySnapshots,
  refreshDirectory,
  refreshTree,
  rootId,
  rootPath,
  skipManualFullEvents,
}: UseFileTreeRefreshEventsParams): () => Promise<FileTreeRefreshResult> {
  const [refreshQueueRef] = useState<RefreshQueueRef>(() => ({
    current: Promise.resolve(),
  }));
  const [pendingFullRefreshRef] = useState<PendingFullRefreshRef>(() => ({ current: null }));
  const [lifecycleEpochRef] = useState<{ current: number }>(() => ({ current: 0 }));
  const getCurrentRootIdentity = useEventCallback((): string =>
    createFullRefreshKey(rootId, rootPath)
  );

  // Commit-phase latest-value dispatcher: queued events execute against the
  // provider identity that is current when their turn begins. A same-path
  // rootId switch therefore cannot make an old event refresh the new root.
  const processRefreshEvent = useEventCallback(
    async (
      detail: FileExplorerRefreshEvent['detail'],
      isActive: RefreshLifecycleGuard
    ): Promise<void> => {
      if (!isActive()) {
        return;
      }
      const current: UseFileTreeRefreshEventsParams = {
        getNormalizedTree,
        getSelectionAncestorDirectories,
        getSelectionProjectionRevision,
        reconcileSelectionWithDirectorySnapshots,
        refreshDirectory,
        refreshTree,
        rootId,
        rootPath,
        skipManualFullEvents,
      };
      await processRefreshEventDetail(detail, current, isActive);
    }
  );

  const enqueueCurrentFullRefresh = useEventCallback(
    (isActive: RefreshLifecycleGuard): Promise<FileTreeRefreshResult> => {
      const current: SelectionAwareRootRefreshParams = {
        getNormalizedTree,
        getSelectionAncestorDirectories,
        getSelectionProjectionRevision,
        reconcileSelectionWithDirectorySnapshots,
        refreshDirectory,
        refreshTree,
      };
      const key = createFullRefreshKey(rootId, rootPath);
      const isCurrentAndActive = (): boolean => isActive() && getCurrentRootIdentity() === key;
      return enqueueCoalescedFullRefresh(refreshQueueRef, pendingFullRefreshRef, key, () =>
        refreshTreeWithSelectionRevalidation(current, isCurrentAndActive)
      );
    }
  );

  const enqueueFullRefreshEvent = useEventCallback(
    (detail: FileExplorerRefreshEvent['detail'], isActive: RefreshLifecycleGuard): boolean => {
      if (!(isActive() && rootPath)) {
        return false;
      }
      const effectiveRootId = rootId ?? rootPath;
      const isManualFull = detail.source === 'manual' && detail.scope === 'full';
      const isWatcherFull = detail.source === 'watcher' && detail.scope === 'full';
      if (isManualFull && skipManualFullEvents) {
        return false;
      }
      if (
        isWatcherFull &&
        !detail.roots.some((root) => matchesRoot(root, effectiveRootId, rootId, rootPath))
      ) {
        return false;
      }
      if (!(isManualFull || isWatcherFull)) {
        return false;
      }

      const result = enqueueCurrentFullRefresh(isActive);
      reportFullRefreshFailure(
        result,
        isManualFull ? 'Manual full tree refresh failed' : 'Watcher overflow tree refresh failed',
        rootPath
      );
      return true;
    }
  );

  const refreshTreeWithSelection = useEventCallback((): Promise<FileTreeRefreshResult> => {
    const lifecycleEpoch = lifecycleEpochRef.current;
    const isActive = (): boolean => lifecycleEpochRef.current === lifecycleEpoch;
    return enqueueCurrentFullRefresh(isActive);
  });

  useEffect(() => {
    const lifecycleEpoch = lifecycleEpochRef.current + 1;
    lifecycleEpochRef.current = lifecycleEpoch;
    const isActive = (): boolean => lifecycleEpochRef.current === lifecycleEpoch;
    const handleRefreshEvent = (event: Event): void => {
      const { detail } = event as FileExplorerRefreshEvent;
      if (enqueueFullRefreshEvent(detail, isActive)) {
        return;
      }
      if (detail.source !== 'watcher' || detail.scope !== 'incremental') {
        return;
      }
      void enqueueOrdinaryRefreshWork(refreshQueueRef, pendingFullRefreshRef, () =>
        processRefreshEvent(detail, isActive)
      ).catch((error: unknown) => {
        logger.warn('Unexpected file tree refresh queue failure', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };

    window.addEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefreshEvent);
    return () => {
      window.removeEventListener(FILE_EXPLORER_REFRESH_EVENT, handleRefreshEvent);
      if (lifecycleEpochRef.current === lifecycleEpoch) {
        lifecycleEpochRef.current = lifecycleEpoch + 1;
      }
      pendingFullRefreshRef.current = null;
    };
  }, [
    enqueueFullRefreshEvent,
    lifecycleEpochRef,
    pendingFullRefreshRef,
    processRefreshEvent,
    refreshQueueRef,
  ]);

  return refreshTreeWithSelection;
}
