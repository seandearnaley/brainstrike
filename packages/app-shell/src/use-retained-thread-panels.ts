import { useCallback, useMemo, useRef, useState } from 'react';

const NO_THREAD_IDS: ReadonlySet<string> = new Set();

export interface RetainedThreadPanels {
  /**
   * Every thread whose panel is mounted: the open tabs plus the retained ones.
   * Ordered by thread id, NOT tab order, so a reopen or a tab reorder never
   * moves an existing panel's DOM node (a browser resets a detached scroller's
   * `scrollTop`).
   */
  readonly mountedThreadIds: readonly string[];
  /** A panel's own `thread.isRunning`; read only when a close removes its tab. */
  readonly onRunningChange: (threadId: string, running: boolean) => void;
  /** Every tab a single close removed, reported inside the close event. */
  readonly onTabsRemoved: (removedThreadIds: readonly string[]) => void;
}

interface RetainedState {
  /** The tab list and resource the retained set was last reconciled against. */
  readonly openThreadIds: readonly string[];
  readonly resourceId: string;
  readonly retainedThreadIds: ReadonlySet<string>;
}

/**
 * Close = hide for a thread whose run is in flight (BST-1844). A thread panel
 * owns its run (the web local runtime aborts it on unmount) and, on web, its
 * whole conversation, so a tab closed mid-run keeps its panel mounted and
 * hidden. The panel stays until the thread is reopened, closed while idle,
 * deleted, or the thread store is reset: never at run end, because the finished
 * conversation lives only in that mounted panel.
 *
 * "Running" is the panel's own `thread.isRunning` (kept in a ref, read only when
 * a close lands), never the durable run row, which lags the send and can outlive
 * its run. Session-only like the closed-tab history: nothing persists, so there
 * is no factory-reset wiring.
 */
export function useRetainedThreadPanels(
  resourceId: string,
  openThreadIds: readonly string[],
  threadById: ReadonlyMap<string, unknown>
): RetainedThreadPanels {
  const [state, setState] = useState<RetainedState>({
    openThreadIds,
    resourceId,
    retainedThreadIds: NO_THREAD_IDS,
  });
  const runningThreadIdsRef = useRef(new Set<string>());

  // Reconciled while rendering, not in an effect: an effect would lag one commit
  // behind, and a tab removed by anything but `onTabsRemoved` (a direct store
  // close, a delete) in that gap would find a reopened thread still retained and
  // leave its tabless panel mounted, hidden, for good. A reopened thread is open
  // again, so it leaves the set; another resource's retained panels are not ours.
  let current = state;
  if (state.resourceId !== resourceId) {
    current = { openThreadIds, resourceId, retainedThreadIds: NO_THREAD_IDS };
    setState(current);
  } else if (state.openThreadIds !== openThreadIds) {
    const open = new Set(openThreadIds);
    const stillRetained = [...state.retainedThreadIds].filter((id) => !open.has(id));
    current = {
      openThreadIds,
      resourceId,
      retainedThreadIds:
        stillRetained.length === state.retainedThreadIds.size
          ? state.retainedThreadIds
          : new Set(stillRetained),
    };
    setState(current);
  }
  const { retainedThreadIds } = current;

  const onRunningChange = useCallback((threadId: string, running: boolean): void => {
    if (running) {
      runningThreadIdsRef.current.add(threadId);
    } else {
      runningThreadIdsRef.current.delete(threadId);
    }
  }, []);

  // Decided here, inside the close event, so the retained set and the store's
  // tab removal render together: an effect-based latch would unmount the panel
  // first and abort the run it exists to keep.
  const onTabsRemoved = useCallback((removedThreadIds: readonly string[]): void => {
    const running = removedThreadIds.filter((id) => runningThreadIdsRef.current.has(id));
    setState((previous) => {
      const next = new Set(previous.retainedThreadIds);
      for (const id of removedThreadIds) {
        next.delete(id);
      }
      for (const id of running) {
        next.add(id);
      }
      return { ...previous, retainedThreadIds: next };
    });
  }, []);

  // A retained thread absent from the loaded threads was deleted (or the store
  // was reset by Clear Database): its panel goes with it. Absence means deletion
  // only while a load replaces the whole list atomically and `listThreads` is
  // neither paginated nor filtered; a partial list would unmount (and so abort)
  // every running panel it omits.
  const mountedThreadIds = useMemo(() => {
    const mounted = new Set(openThreadIds);
    for (const id of retainedThreadIds) {
      if (threadById.has(id)) {
        mounted.add(id);
      }
    }
    return [...mounted].sort();
  }, [openThreadIds, retainedThreadIds, threadById]);

  return { mountedThreadIds, onRunningChange, onTabsRemoved };
}
