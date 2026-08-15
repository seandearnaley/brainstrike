import type { ThreadWorkspaceRepository, WorkspaceSnapshotV1 } from '@brainstrike/assistant-data';
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
  const previousThreadIdRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const switchIntentRef = useRef(0);
  const facadeRef = useRef(facade);
  facadeRef.current = facade;

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
    if (previous === activeThreadId) {
      return;
    }
    previousThreadIdRef.current = activeThreadId;
    switchIntentRef.current += 1;
    const intent = switchIntentRef.current;

    // Flush the OUTGOING thread synchronously — the live stores still hold
    // its state (nothing has hydrated yet).
    if (previous !== null && repository) {
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
      return;
    }

    const hydrate = (snapshot: WorkspaceSnapshotV1) => {
      hydratingRef.current = true;
      try {
        applyWorkspaceSnapshot(snapshot, facadeRef.current);
      } finally {
        hydratingRef.current = false;
      }
    };

    const cached = cacheRef.current.get(activeThreadId);
    if (cached) {
      hydrate(cached);
      return;
    }
    if (!repository) {
      // Boot before the database is ready: live stores already show the
      // last-active workspace (their own persistence) — nothing to do.
      return;
    }
    repository
      .getThreadWorkspace(activeThreadId)
      .then((snapshot) => {
        if (switchIntentRef.current !== intent) {
          return; // A newer switch superseded this fetch.
        }
        if (snapshot) {
          cacheRef.current.set(activeThreadId, snapshot);
          hydrate(snapshot);
          return;
        }
        // No row: INHERIT the current workspace (new thread, or first run
        // after upgrade). The live stores already show it — persist as-is.
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
        logger.error('Failed to load thread workspace snapshot', {
          error: error instanceof Error ? error.message : String(error),
          threadId: activeThreadId,
        });
      });
  }, [activeThreadId, repository, resourceId]);
}
