import { registerFactoryResetPreparation } from '@brainstrike/app-state/factory-reset';
import type {
  ThreadWorkspaceRepository,
  WorkspaceSnapshotEditor,
  WorkspaceSnapshotV1,
} from '@brainstrike/assistant-data';
import { ThreadWorkspaceUnavailableError } from '@brainstrike/assistant-data';
import { createLogger } from '@brainstrike/logging';
import { useEffect, useEffectEvent, useMemo, useRef, useSyncExternalStore } from 'react';
import { isDelegatedWorkspaceTabId } from '../delegated-workspace-tab';
import { isHostChildWorkspaceTabId } from '../host-child-workspace-tab';
import type { ThreadWorkspaceNavigation } from './thread-workspace-navigation';
import {
  applyWorkspaceSnapshot,
  captureWorkspaceSnapshot,
  type WorkspaceStateFacade,
} from './workspace-snapshot-io';

const emptySubscribe = () => () => undefined;
const emptySnapshot = () => 0;

const logger = createLogger('ThreadWorkspaceCoordinator');

export const THREAD_WORKSPACE_SAVE_DEBOUNCE_MS = 500;

export interface ThreadWorkspaceCoordinatorOptions {
  readonly activeThreadId: string | null;
  readonly debounceMs?: number;
  readonly facade: WorkspaceStateFacade;
  readonly navigation?: ThreadWorkspaceNavigation;
  readonly openThreadIds: readonly string[];
  readonly repository: ThreadWorkspaceRepository | null;
  readonly resourceId: string;
  /** Aggregated subscription over every live workspace store. */
  readonly subscribe: (listener: () => void) => () => void;
}

type SnapshotEditors = Readonly<Record<string, WorkspaceSnapshotEditor>>;
type MutableSnapshotEditors = Record<string, WorkspaceSnapshotEditor>;
interface BootHydrationRecord {
  readonly snapshot: WorkspaceSnapshotV1;
  readonly threadId: string;
}
interface PendingHydrationSave {
  readonly intent: number;
  readonly threadId: string;
}

function clearWorkspaceSaveTimer(timer: { current: ReturnType<typeof setTimeout> | null }): void {
  if (timer.current === null) {
    return;
  }
  clearTimeout(timer.current);
  timer.current = null;
}

function matchesPendingHydrationSave(
  pending: PendingHydrationSave | null,
  intent: number,
  threadId: string
): boolean {
  return pending?.intent === intent && pending.threadId === threadId;
}

function rejectUnavailableChildNavigation(
  repository: ThreadWorkspaceRepository | null,
  navigation: ThreadWorkspaceNavigation | undefined,
  resourceId: string,
  activeThreadId: string | null
): void {
  if (!repository && activeThreadId && navigation?.hasPending(resourceId, activeThreadId)) {
    navigation.failed(
      resourceId,
      activeThreadId,
      new Error('Conversation storage is not ready. Open the child again after loading completes.')
    );
  }
}

function isChildConversationTabId(appId: string): boolean {
  return isHostChildWorkspaceTabId(appId) || isDelegatedWorkspaceTabId(appId);
}

function hasPendingWorkspaceHydration(
  bootThreadId: string | null,
  threadId: string,
  resourceId: string,
  navigation: ThreadWorkspaceNavigation | undefined
): boolean {
  return bootThreadId === threadId || navigation?.hasPending(resourceId, threadId) === true;
}

function stringListsMatch(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function nullableStringListsMatch(
  left: readonly string[] | null,
  right: readonly string[] | null
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return stringListsMatch(left, right);
}

function selectionsMatch(
  left: WorkspaceSnapshotV1['apps']['selection'],
  right: WorkspaceSnapshotV1['apps']['selection']
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'app' && right.kind === 'app') {
    return left.appId === right.appId;
  }
  if (left.kind === 'file' && right.kind === 'file') {
    return left.tabId === right.tabId;
  }
  return true;
}

function fileTabsMatch(
  left: WorkspaceSnapshotV1['fileTabs']['tabs'],
  right: WorkspaceSnapshotV1['fileTabs']['tabs']
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (tab, index) =>
        tab.compositeKey === right[index]?.compositeKey && tab.path === right[index]?.path
    )
  );
}

function expansionsMatch(
  left: WorkspaceSnapshotV1['explorer']['byRoot'],
  right: WorkspaceSnapshotV1['explorer']['byRoot']
): boolean {
  const leftEntries = Object.entries(left);
  const rightKeys = Object.keys(right);
  if (leftEntries.length !== rightKeys.length) {
    return false;
  }
  for (const [rootId, entry] of leftEntries) {
    const rightEntry = right[rootId];
    if (!(rightEntry && stringListsMatch(entry.expandedPaths, rightEntry.expandedPaths))) {
      return false;
    }
  }
  return true;
}

function panesMatch(
  left: WorkspaceSnapshotEditor['pane'],
  right: WorkspaceSnapshotEditor['pane']
): boolean {
  return (
    left?.open === right?.open &&
    left?.widthPct === right?.widthPct &&
    left?.expandedPaths?.join('\0') === right?.expandedPaths?.join('\0')
  );
}

function mergeEditorEdits(
  snapshot: WorkspaceSnapshotV1,
  baseline: WorkspaceSnapshotV1,
  live: WorkspaceSnapshotV1
): { readonly changed: boolean; readonly editors: SnapshotEditors } {
  const loadedTabKeys = new Set(snapshot.fileTabs.tabs.map((tab) => tab.compositeKey));
  const editors: MutableSnapshotEditors = { ...snapshot.editors };
  let changed = false;
  for (const compositeKey of loadedTabKeys) {
    const baselineEditor = baseline.editors[compositeKey];
    const liveEditor = live.editors[compositeKey];
    if (!(baselineEditor && liveEditor)) {
      continue;
    }
    let editor: WorkspaceSnapshotEditor = { ...editors[compositeKey] };
    if (baselineEditor.mode !== liveEditor.mode) {
      const { mode: _mode, ...withoutMode } = editor;
      editor =
        liveEditor.mode === undefined ? withoutMode : { ...withoutMode, mode: liveEditor.mode };
      changed = true;
    }
    if (!panesMatch(baselineEditor.pane, liveEditor.pane)) {
      const { pane: _pane, ...withoutPane } = editor;
      editor =
        liveEditor.pane === undefined ? withoutPane : { ...withoutPane, pane: liveEditor.pane };
      changed = true;
    }
    if (baselineEditor.scrollTop !== liveEditor.scrollTop) {
      const { scrollTop: _scrollTop, ...withoutScrollTop } = editor;
      editor =
        liveEditor.scrollTop === undefined
          ? withoutScrollTop
          : { ...withoutScrollTop, scrollTop: liveEditor.scrollTop };
      changed = true;
    }
    editors[compositeKey] = editor;
  }
  return { changed, editors };
}

function mergeExplorerEdits(
  snapshot: WorkspaceSnapshotV1,
  baseline: WorkspaceSnapshotV1,
  live: WorkspaceSnapshotV1
): { readonly changed: boolean; readonly explorer: WorkspaceSnapshotV1['explorer'] } {
  const expansionsChanged = !expansionsMatch(baseline.explorer.byRoot, live.explorer.byRoot);
  const scrollChanged = baseline.explorer.scrollTop !== live.explorer.scrollTop;
  const byRoot = expansionsChanged ? live.explorer.byRoot : snapshot.explorer.byRoot;
  const scrollTop = scrollChanged ? live.explorer.scrollTop : snapshot.explorer.scrollTop;
  return {
    changed: expansionsChanged || scrollChanged,
    explorer: scrollTop === undefined ? { byRoot } : { byRoot, scrollTop },
  };
}

function mergeBootEditsIntoSnapshot(
  snapshot: WorkspaceSnapshotV1,
  baseline: WorkspaceSnapshotV1,
  live: WorkspaceSnapshotV1
): WorkspaceSnapshotV1 | null {
  let changed = false;

  const openAppIdsChanged = !stringListsMatch(baseline.apps.openAppIds, live.apps.openAppIds);
  const selectionChanged = !selectionsMatch(baseline.apps.selection, live.apps.selection);
  const apps = {
    openAppIds: openAppIdsChanged ? live.apps.openAppIds : snapshot.apps.openAppIds,
    selection: selectionChanged ? live.apps.selection : snapshot.apps.selection,
  };
  changed ||= openAppIdsChanged || selectionChanged;

  const tabSetChanged = !fileTabsMatch(baseline.fileTabs.tabs, live.fileTabs.tabs);
  const loadedTabKeys = new Set(snapshot.fileTabs.tabs.map((tab) => tab.compositeKey));
  const activeTabChanged =
    baseline.fileTabs.activeTabId !== live.fileTabs.activeTabId &&
    (live.fileTabs.activeTabId === null || loadedTabKeys.has(live.fileTabs.activeTabId));
  const fileTabs = tabSetChanged
    ? live.fileTabs
    : {
        activeTabId: activeTabChanged ? live.fileTabs.activeTabId : snapshot.fileTabs.activeTabId,
        tabs: snapshot.fileTabs.tabs,
      };
  changed ||= tabSetChanged || activeTabChanged;

  const editorMerge = tabSetChanged
    ? { changed: true, editors: live.editors }
    : mergeEditorEdits(snapshot, baseline, live);
  changed ||= editorMerge.changed;

  const explorerMerge = mergeExplorerEdits(snapshot, baseline, live);
  changed ||= explorerMerge.changed;

  const focusedRootChanged = baseline.roots.focusedRootId !== live.roots.focusedRootId;
  const visibleRootsChanged = !nullableStringListsMatch(
    baseline.roots.visibleRootIds,
    live.roots.visibleRootIds
  );
  const roots = {
    focusedRootId: focusedRootChanged ? live.roots.focusedRootId : snapshot.roots.focusedRootId,
    visibleRootIds: visibleRootsChanged ? live.roots.visibleRootIds : snapshot.roots.visibleRootIds,
  };
  changed ||= focusedRootChanged || visibleRootsChanged;

  return changed
    ? {
        ...snapshot,
        apps,
        editors: editorMerge.editors,
        explorer: explorerMerge.explorer,
        fileTabs,
        roots,
      }
    : null;
}

function prepareBootHydrationBaseline(
  activeThreadId: string | null,
  preserveLiveBootEdits: boolean,
  baseline: BootHydrationRecord | null,
  facade: WorkspaceStateFacade
): BootHydrationRecord | null {
  if (activeThreadId === null || !preserveLiveBootEdits) {
    return null;
  }
  if (baseline?.threadId === activeThreadId) {
    return baseline;
  }
  return { snapshot: captureWorkspaceSnapshot(facade), threadId: activeThreadId };
}

function shouldPreserveLiveBootEdits(
  activeThreadId: string | null,
  hasActivatedThread: boolean,
  isDeferredBootHydration: boolean,
  pendingBootPreserveEdits: boolean
): boolean {
  return (
    (activeThreadId !== null && !hasActivatedThread) ||
    (isDeferredBootHydration && pendingBootPreserveEdits)
  );
}

/**
 * The thread⇄workspace binding (BST-1268). Live stores stay the single
 * working state; this hook:
 *
 * - debounce-persists the CURRENT thread's captured snapshot on any live
 *   store change (suppressed while hydrating — a hydration must never echo
 *   back as a save, least of all under the wrong thread id);
 * - on active-thread change, flushes the outgoing thread's snapshot
 *   synchronously (the workspace stores still hold the outgoing state at
 *   that point), then hydrates the incoming thread from the in-memory cache
 *   (synchronous) or the repository (async, intent-guarded against a further
 *   switch), INHERITING the current workspace minus the outgoing thread's
 *   child-conversation tabs when no row exists (the new-thread semantic);
 * - preloads snapshots for all OPEN thread tabs so switching is instant;
 * - prunes cache entries for threads that are no longer open (delete/close).
 *
 * Repository failures log + toast upstream and never wedge switching: pending
 * live edits persist immediately on a failed initial read, while the stores
 * remain the working authority.
 */
export function useThreadWorkspaceCoordinator({
  activeThreadId,
  navigation,
  debounceMs = THREAD_WORKSPACE_SAVE_DEBOUNCE_MS,
  facade,
  openThreadIds,
  repository: sourceRepository,
  resourceId,
  subscribe,
}: ThreadWorkspaceCoordinatorOptions): void {
  const navigationRevision = useSyncExternalStore(
    navigation?.subscribe ?? emptySubscribe,
    navigation?.getSnapshot ?? emptySnapshot
  );
  useEffect(() => () => navigation?.loading(resourceId, null), [navigation, resourceId]);
  const cacheRef = useRef(new Map<string, WorkspaceSnapshotV1>());
  const hydratingRef = useRef(false);
  /** Active async hydration; live-store notifications must not overwrite it. */
  const hydrationThreadRef = useRef<string | null>(null);
  /** Thread whose boot hydration was deferred because the DB was not ready. */
  const pendingBootHydrateRef = useRef<string | null>(null);
  /** Whether deferred boot hydration may preserve live edits made while waiting for the DB. */
  const pendingBootPreserveEditsRef = useRef(false);
  /** Workspace state at boot-hydration start, used to identify later user edits. */
  const bootHydrationBaselineRef = useRef<BootHydrationRecord | null>(null);
  /** A live edit suppressed behind the current initial snapshot read. */
  const pendingHydrationSaveRef = useRef<PendingHydrationSave | null>(null);
  const hasActivatedThreadRef = useRef(false);
  const previousThreadIdRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const switchIntentRef = useRef(0);
  const facadeRef = useRef(facade);
  const resetPreparedRef = useRef(false);
  const pendingOperationsRef = useRef(new Set<Promise<unknown>>());
  const repository = useMemo<ThreadWorkspaceRepository | null>(() => {
    if (!sourceRepository) {
      return null;
    }
    const track = <T>(pending: Promise<T>): Promise<T> => {
      pendingOperationsRef.current.add(pending);
      const settled = () => {
        pendingOperationsRef.current.delete(pending);
      };
      void pending.then(settled, settled);
      return pending;
    };
    return {
      getThreadWorkspace: (threadId) => track(sourceRepository.getThreadWorkspace(threadId)),
      getThreadWorkspaces: (threadIds) => track(sourceRepository.getThreadWorkspaces(threadIds)),
      setThreadWorkspace: (threadId, ownerId, snapshot) =>
        track(sourceRepository.setThreadWorkspace(threadId, ownerId, snapshot)),
    };
  }, [sourceRepository]);
  const prepareReset = useEffectEvent(async () => {
    // Reset clears subscribed stores before retiring their durable owner.
    // Cancel future snapshots, then join operations already admitted by this owner.
    resetPreparedRef.current = true;
    switchIntentRef.current += 1;
    hydrationThreadRef.current = null;
    pendingHydrationSaveRef.current = null;
    cacheRef.current.clear();
    clearWorkspaceSaveTimer(saveTimerRef);
    const operations = await Promise.allSettled([...pendingOperationsRef.current]);
    const failures: unknown[] = operations.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Thread workspace operations failed during reset preparation'
      );
    }
  });
  useEffect(() => registerFactoryResetPreparation(prepareReset), []);

  const handlePersistError = useEffectEvent((threadId: string, error: unknown, message: string) => {
    if (error instanceof ThreadWorkspaceUnavailableError) {
      cacheRef.current.delete(threadId);
      // Deletion cancels an outgoing save; a still-active owner failure
      // remains visible, as do all database/serialization failures below.
      if (activeThreadId !== threadId) {
        logger.debug('Cancelled outgoing workspace save after native ownership was revoked', {
          threadId,
        });
        return;
      }
      navigation?.failed(resourceId, threadId, error);
    }
    logger.error(message, {
      error: error instanceof Error ? error.message : String(error),
      threadId,
    });
  });
  // Before workspace effects: later effects in this hook read facadeRef, and
  // same-commit effect order is declaration order.
  useEffect(() => {
    facadeRef.current = facade;
  });

  // ---- Debounced continuous save for the active thread ----
  useEffect(() => {
    if (resetPreparedRef.current || !repository || activeThreadId === null) {
      return;
    }
    const persist = () => {
      saveTimerRef.current = null;
      if (resetPreparedRef.current) {
        return;
      }
      const snapshot = captureWorkspaceSnapshot(facadeRef.current);
      cacheRef.current.set(activeThreadId, snapshot);
      repository.setThreadWorkspace(activeThreadId, resourceId, snapshot).catch((error) => {
        handlePersistError(activeThreadId, error, 'Failed to persist thread workspace snapshot');
      });
    };
    let previousAppIds = [...facadeRef.current.getOpenAppIds()];
    let previousSelection = facadeRef.current.getSelection();
    const unsubscribe = subscribe(() => {
      if (resetPreparedRef.current) {
        return;
      }
      const appIds = facadeRef.current.getOpenAppIds();
      const selection = facadeRef.current.getSelection();
      const appsChanged = !(
        stringListsMatch(previousAppIds, appIds) && selectionsMatch(previousSelection, selection)
      );
      previousAppIds = [...appIds];
      previousSelection = selection;
      if (hydratingRef.current) {
        return;
      }
      if (hydrationThreadRef.current === activeThreadId) {
        pendingHydrationSaveRef.current = {
          intent: switchIntentRef.current,
          threadId: activeThreadId,
        };
        return;
      }
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
      }
      // Tab ownership/selection must reach persistence before a reload can
      // discard the debounce timer. High-frequency viewport edits stay batched.
      if (appsChanged) {
        persist();
        return;
      }
      saveTimerRef.current = setTimeout(persist, debounceMs);
    });
    return () => {
      unsubscribe();
      if (saveTimerRef.current !== null) {
        // Flush rather than drop: an unmount mid-debounce must not lose the
        // last edits (mirrors the debounced storage adapters' flush-on-close).
        clearTimeout(saveTimerRef.current);
        persist();
      }
    };
  }, [activeThreadId, debounceMs, repository, resourceId, subscribe]);

  // ---- Preload snapshots for open thread tabs ----
  useEffect(() => {
    if (resetPreparedRef.current || !repository || openThreadIds.length === 0) {
      return;
    }
    const missing = openThreadIds.filter((threadId) => !cacheRef.current.has(threadId));
    if (missing.length === 0) {
      return;
    }
    let cancelled = false;
    repository
      .getThreadWorkspaces(missing)
      .then((snapshots) => {
        if (cancelled || resetPreparedRef.current) {
          return;
        }
        for (const [threadId, snapshot] of snapshots) {
          if (!cacheRef.current.has(threadId)) {
            cacheRef.current.set(threadId, snapshot);
          }
        }
      })
      .catch((error) => {
        logger.error('Failed to preload thread workspace snapshots', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [openThreadIds, repository]);

  // ---- Prune cache entries for threads no longer open ----
  useEffect(() => {
    const keep = new Set(openThreadIds);
    if (activeThreadId !== null) {
      keep.add(activeThreadId);
    }
    for (const threadId of cacheRef.current.keys()) {
      if (!keep.has(threadId)) {
        cacheRef.current.delete(threadId);
      }
    }
  }, [openThreadIds, activeThreadId]);

  // ---- Switch handling ----
  useEffect(() => {
    if (resetPreparedRef.current) {
      return;
    }
    rejectUnavailableChildNavigation(repository, navigation, resourceId, activeThreadId);
    const previous = previousThreadIdRef.current;
    const isDeferredBootHydration =
      previous === activeThreadId &&
      activeThreadId !== null &&
      repository !== null &&
      hasPendingWorkspaceHydration(
        pendingBootHydrateRef.current,
        activeThreadId,
        resourceId,
        navigation
      );
    if (previous === activeThreadId && !isDeferredBootHydration) {
      return;
    }

    navigation?.loading(resourceId, activeThreadId);
    const preserveLiveBootEdits = shouldPreserveLiveBootEdits(
      activeThreadId,
      hasActivatedThreadRef.current,
      isDeferredBootHydration,
      pendingBootPreserveEditsRef.current
    );
    if (activeThreadId !== null) {
      hasActivatedThreadRef.current = true;
    }
    pendingBootHydrateRef.current = null;
    pendingBootPreserveEditsRef.current = false;
    previousThreadIdRef.current = activeThreadId;
    switchIntentRef.current += 1;
    const intent = switchIntentRef.current;
    if (!isDeferredBootHydration) {
      hydrationThreadRef.current = null;
      pendingHydrationSaveRef.current = null;
    }

    bootHydrationBaselineRef.current = prepareBootHydrationBaseline(
      activeThreadId,
      preserveLiveBootEdits,
      bootHydrationBaselineRef.current,
      facadeRef.current
    );

    // Flush the OUTGOING thread synchronously — the live stores still hold
    // its state (nothing has hydrated yet). NEVER on a deferred boot
    // hydration: there is no outgoing thread, and flushing would overwrite
    // the saved row with the un-hydrated boot state and then hydrate that
    // empty flush right back.
    if (previous !== null && repository && !isDeferredBootHydration) {
      clearWorkspaceSaveTimer(saveTimerRef);
      const outgoing = captureWorkspaceSnapshot(facadeRef.current);
      cacheRef.current.set(previous, outgoing);
      repository.setThreadWorkspace(previous, resourceId, outgoing).catch((error) => {
        handlePersistError(previous, error, 'Failed to persist outgoing thread workspace snapshot');
      });
    }

    if (activeThreadId === null) {
      hydrationThreadRef.current = null;
      return;
    }

    const clearHydrationTracking = () => {
      if (switchIntentRef.current !== intent) {
        return;
      }
      hydrationThreadRef.current = null;
      bootHydrationBaselineRef.current = null;
      pendingHydrationSaveRef.current = null;
    };
    const hydrate = (snapshot: WorkspaceSnapshotV1) => {
      hydratingRef.current = true;
      try {
        applyWorkspaceSnapshot(snapshot, facadeRef.current);
      } finally {
        hydratingRef.current = false;
        clearHydrationTracking();
      }
      navigation?.complete(resourceId, activeThreadId);
    };
    const hydrateLoadedSnapshot = (snapshot: WorkspaceSnapshotV1) => {
      const baseline = bootHydrationBaselineRef.current;
      if (preserveLiveBootEdits && baseline?.threadId === activeThreadId) {
        const live = captureWorkspaceSnapshot(facadeRef.current);
        const merged = mergeBootEditsIntoSnapshot(snapshot, baseline.snapshot, live);
        if (merged) {
          cacheRef.current.set(activeThreadId, merged);
          hydrate(merged);
          repository?.setThreadWorkspace(activeThreadId, resourceId, merged).catch((error) => {
            handlePersistError(
              activeThreadId,
              error,
              'Failed to persist live edits after workspace hydration'
            );
          });
          return;
        }
      }
      cacheRef.current.set(activeThreadId, snapshot);
      hydrate(snapshot);
    };

    const cached = cacheRef.current.get(activeThreadId);
    if (cached) {
      hydrateLoadedSnapshot(cached);
      return;
    }
    if (!repository) {
      // Boot before the database is ready (reload reality: activeThreadId
      // restores from localStorage instantly, PGlite takes seconds). The
      // persisted singleton stores already show a workspace; remember the
      // thread so hydration runs when the repository arrives — session-only
      // state (per-tab panes) has no other restore path.
      pendingBootHydrateRef.current = activeThreadId;
      pendingBootPreserveEditsRef.current = preserveLiveBootEdits;
      return;
    }
    hydrationThreadRef.current = activeThreadId;
    repository
      .getThreadWorkspace(activeThreadId)
      .then((snapshot) => {
        if (switchIntentRef.current !== intent) {
          return; // A newer switch superseded this fetch.
        }
        if (snapshot) {
          hydrateLoadedSnapshot(snapshot);
          return;
        }
        // No row: INHERIT the current workspace (new thread). The live stores
        // already show it; only the outgoing thread's child conversations
        // stay behind, because they belong to that thread's tree.
        const childTabs = facadeRef.current.getOpenAppIds().filter(isChildConversationTabId);
        if (childTabs.length > 0) {
          hydratingRef.current = true;
          try {
            facadeRef.current.closeApps(childTabs);
          } finally {
            hydratingRef.current = false;
          }
        }
        clearHydrationTracking();
        navigation?.complete(resourceId, activeThreadId);
        const inherited = captureWorkspaceSnapshot(facadeRef.current);
        cacheRef.current.set(activeThreadId, inherited);
        repository.setThreadWorkspace(activeThreadId, resourceId, inherited).catch((error) => {
          handlePersistError(
            activeThreadId,
            error,
            'Failed to persist inherited thread workspace snapshot'
          );
        });
      })
      .catch((error) => {
        const hasPendingSave = matchesPendingHydrationSave(
          pendingHydrationSaveRef.current,
          intent,
          activeThreadId
        );
        if (switchIntentRef.current === intent) {
          clearHydrationTracking();
          navigation?.failed(resourceId, activeThreadId, error);
          if (hasPendingSave) {
            const pending = captureWorkspaceSnapshot(facadeRef.current);
            cacheRef.current.set(activeThreadId, pending);
            repository
              .setThreadWorkspace(activeThreadId, resourceId, pending)
              .catch((saveError) => {
                handlePersistError(
                  activeThreadId,
                  saveError,
                  'Failed to persist live edits after workspace hydration failure'
                );
              });
          }
        }
        logger.error('Failed to load thread workspace snapshot', {
          error: error instanceof Error ? error.message : String(error),
          threadId: activeThreadId,
        });
      });
  }, [activeThreadId, navigation, navigationRevision, repository, resourceId]);
}
