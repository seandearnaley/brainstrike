import type {
  ThreadWorkspaceRepository,
  WorkspaceSnapshotEditor,
  WorkspaceSnapshotV1,
} from '@brainstrike/assistant-data';
import { createLogger } from '@brainstrike/logging';
import { useEffect, useRef } from 'react';
import {
  applyWorkspaceSnapshot,
  captureWorkspaceSnapshot,
  type WorkspaceStateFacade,
} from './workspace-snapshot-io';

const logger = createLogger('ThreadWorkspaceCoordinator');

export const THREAD_WORKSPACE_SAVE_DEBOUNCE_MS = 500;

export interface ThreadWorkspaceCoordinatorOptions {
  readonly activeThreadId: string | null;
  readonly debounceMs?: number;
  readonly facade: WorkspaceStateFacade;
  readonly openThreadIds: readonly string[];
  readonly repository: ThreadWorkspaceRepository | null;
  readonly resourceId: string;
  /** Aggregated subscription over every live workspace store. */
  readonly subscribe: (listener: () => void) => () => void;
}

type SnapshotEditors = Readonly<Record<string, WorkspaceSnapshotEditor>>;
type MutableSnapshotEditors = Record<string, WorkspaceSnapshotEditor>;
interface PaneHydrationRecord {
  readonly editors: SnapshotEditors;
  readonly threadId: string;
}

function capturePaneEditors(facade: WorkspaceStateFacade): MutableSnapshotEditors {
  const editors: MutableSnapshotEditors = {};
  for (const [compositeKey, editor] of Object.entries(captureWorkspaceSnapshot(facade).editors)) {
    if (editor.pane) {
      editors[compositeKey] = { pane: editor.pane };
    }
  }
  return editors;
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

function capturePaneEdits(
  baseline: SnapshotEditors,
  facade: WorkspaceStateFacade
): MutableSnapshotEditors | null {
  const live = capturePaneEditors(facade);
  const edits: MutableSnapshotEditors = {};
  for (const [compositeKey, editor] of Object.entries(live)) {
    if (!panesMatch(baseline[compositeKey]?.pane, editor.pane)) {
      edits[compositeKey] = editor;
    }
  }
  return Object.keys(edits).length > 0 ? edits : null;
}

function mergePaneEditsIntoSnapshot(
  snapshot: WorkspaceSnapshotV1,
  paneEdits: SnapshotEditors
): WorkspaceSnapshotV1 | null {
  const openTabKeys = new Set(snapshot.fileTabs.tabs.map((tab) => tab.compositeKey));
  const editors: MutableSnapshotEditors = { ...snapshot.editors };
  let changed = false;
  for (const [compositeKey, editor] of Object.entries(paneEdits)) {
    if (!(editor.pane && openTabKeys.has(compositeKey))) {
      continue;
    }
    editors[compositeKey] = {
      ...editors[compositeKey],
      pane: editor.pane,
    };
    changed = true;
  }
  return changed ? { ...snapshot, editors } : null;
}

function preparePaneHydrationBaseline(
  activeThreadId: string | null,
  preserveLiveBootPanes: boolean,
  baseline: PaneHydrationRecord | null,
  facade: WorkspaceStateFacade
): PaneHydrationRecord | null {
  if (activeThreadId === null || !preserveLiveBootPanes) {
    return null;
  }
  if (baseline?.threadId === activeThreadId) {
    return baseline;
  }
  return { editors: capturePaneEditors(facade), threadId: activeThreadId };
}

function shouldPreserveLiveBootPanes(
  activeThreadId: string | null,
  hasActivatedThread: boolean,
  isDeferredBootHydration: boolean,
  pendingBootPreservePanes: boolean
): boolean {
  return (
    (activeThreadId !== null && !hasActivatedThread) ||
    (isDeferredBootHydration && pendingBootPreservePanes)
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
 *   switch), INHERITING the current workspace when no row exists — which is
 *   both the new-thread semantic and the first-run upgrade path;
 * - preloads snapshots for all OPEN thread tabs so switching is instant;
 * - prunes cache entries for threads that are no longer open (delete/close).
 *
 * Repository failures log + toast upstream and never wedge switching: the
 * live stores remain correct and the row heals on the next debounce.
 */
export function useThreadWorkspaceCoordinator({
  activeThreadId,
  debounceMs = THREAD_WORKSPACE_SAVE_DEBOUNCE_MS,
  facade,
  openThreadIds,
  repository,
  resourceId,
  subscribe,
}: ThreadWorkspaceCoordinatorOptions): void {
  const cacheRef = useRef(new Map<string, WorkspaceSnapshotV1>());
  const hydratingRef = useRef(false);
  /** Active async hydration; live-store notifications must not overwrite it. */
  const hydrationThreadRef = useRef<string | null>(null);
  /** Thread whose boot hydration was deferred because the DB was not ready. */
  const pendingBootHydrateRef = useRef<string | null>(null);
  /** Whether deferred boot hydration may preserve pane edits made while waiting for the DB. */
  const pendingBootPreservePanesRef = useRef(false);
  /** Pane state at the start of boot hydration, used to identify later user edits. */
  const hydrationPaneBaselineRef = useRef<PaneHydrationRecord | null>(null);
  const hasActivatedThreadRef = useRef(false);
  const previousThreadIdRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const switchIntentRef = useRef(0);
  const facadeRef = useRef(facade);
  // FIRST effect on purpose: later effects in this hook read facadeRef, and
  // same-commit effect order is declaration order.
  useEffect(() => {
    facadeRef.current = facade;
  });

  // ---- Debounced continuous save for the active thread ----
  useEffect(() => {
    if (!repository || activeThreadId === null) {
      return;
    }
    const persist = () => {
      saveTimerRef.current = null;
      const snapshot = captureWorkspaceSnapshot(facadeRef.current);
      cacheRef.current.set(activeThreadId, snapshot);
      repository.setThreadWorkspace(activeThreadId, resourceId, snapshot).catch((error) => {
        logger.error('Failed to persist thread workspace snapshot', {
          error: error instanceof Error ? error.message : String(error),
          threadId: activeThreadId,
        });
      });
    };
    const unsubscribe = subscribe(() => {
      if (hydratingRef.current) {
        return;
      }
      if (
        hydrationThreadRef.current === activeThreadId ||
        pendingBootHydrateRef.current === activeThreadId
      ) {
        return;
      }
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
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
    if (!repository || openThreadIds.length === 0) {
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
        if (cancelled) {
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
    const previous = previousThreadIdRef.current;
    const isDeferredBootHydration =
      previous === activeThreadId &&
      activeThreadId !== null &&
      repository !== null &&
      pendingBootHydrateRef.current === activeThreadId;
    if (previous === activeThreadId && !isDeferredBootHydration) {
      return;
    }

    const preserveLiveBootPanes = shouldPreserveLiveBootPanes(
      activeThreadId,
      hasActivatedThreadRef.current,
      isDeferredBootHydration,
      pendingBootPreservePanesRef.current
    );
    if (activeThreadId !== null) {
      hasActivatedThreadRef.current = true;
    }
    pendingBootHydrateRef.current = null;
    pendingBootPreservePanesRef.current = false;
    previousThreadIdRef.current = activeThreadId;
    switchIntentRef.current += 1;
    const intent = switchIntentRef.current;

    hydrationPaneBaselineRef.current = preparePaneHydrationBaseline(
      activeThreadId,
      preserveLiveBootPanes,
      hydrationPaneBaselineRef.current,
      facadeRef.current
    );

    // Flush the OUTGOING thread synchronously — the live stores still hold
    // its state (nothing has hydrated yet). NEVER on a deferred boot
    // hydration: there is no outgoing thread, and flushing would overwrite
    // the saved row with the un-hydrated boot state and then hydrate that
    // empty flush right back.
    if (previous !== null && repository && !isDeferredBootHydration) {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const outgoing = captureWorkspaceSnapshot(facadeRef.current);
      cacheRef.current.set(previous, outgoing);
      repository.setThreadWorkspace(previous, resourceId, outgoing).catch((error) => {
        logger.error('Failed to persist outgoing thread workspace snapshot', {
          error: error instanceof Error ? error.message : String(error),
          threadId: previous,
        });
      });
    }

    if (activeThreadId === null) {
      hydrationThreadRef.current = null;
      return;
    }

    const clearHydrationTracking = () => {
      if (hydrationThreadRef.current === activeThreadId) {
        hydrationThreadRef.current = null;
      }
      if (hydrationPaneBaselineRef.current?.threadId === activeThreadId) {
        hydrationPaneBaselineRef.current = null;
      }
    };
    const hydrate = (snapshot: WorkspaceSnapshotV1) => {
      hydratingRef.current = true;
      try {
        applyWorkspaceSnapshot(snapshot, facadeRef.current);
      } finally {
        hydratingRef.current = false;
        clearHydrationTracking();
      }
    };
    const hydrateLoadedSnapshot = (snapshot: WorkspaceSnapshotV1) => {
      const baseline = hydrationPaneBaselineRef.current;
      if (preserveLiveBootPanes && baseline?.threadId === activeThreadId) {
        const paneEdits = capturePaneEdits(baseline.editors, facadeRef.current);
        const merged = paneEdits ? mergePaneEditsIntoSnapshot(snapshot, paneEdits) : null;
        if (merged) {
          cacheRef.current.set(activeThreadId, merged);
          hydrate(merged);
          repository?.setThreadWorkspace(activeThreadId, resourceId, merged).catch((error) => {
            logger.error('Failed to persist live pane state after workspace hydration', {
              error: error instanceof Error ? error.message : String(error),
              threadId: activeThreadId,
            });
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
      pendingBootPreservePanesRef.current = preserveLiveBootPanes;
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
        // No row: INHERIT the current workspace (new thread, or first run
        // after upgrade). The live stores already show it — persist as-is.
        clearHydrationTracking();
        const inherited = captureWorkspaceSnapshot(facadeRef.current);
        cacheRef.current.set(activeThreadId, inherited);
        repository.setThreadWorkspace(activeThreadId, resourceId, inherited).catch((error) => {
          logger.error('Failed to persist inherited thread workspace snapshot', {
            error: error instanceof Error ? error.message : String(error),
            threadId: activeThreadId,
          });
        });
      })
      .catch((error) => {
        if (switchIntentRef.current === intent) {
          clearHydrationTracking();
        }
        logger.error('Failed to load thread workspace snapshot', {
          error: error instanceof Error ? error.message : String(error),
          threadId: activeThreadId,
        });
      });
  }, [activeThreadId, repository, resourceId]);
}
