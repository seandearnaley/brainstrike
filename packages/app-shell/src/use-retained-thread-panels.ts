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
  openThreadIds: readonly string[],
  threadById: ReadonlyMap<string, unknown>
): RetainedThreadPanels {
  const [retainedThreadIds, setRetainedThreadIds] = useState<ReadonlySet<string>>(NO_THREAD_IDS);
  const runningThreadIdsRef = useRef(new Set<string>());

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
    setRetainedThreadIds((current) => {
      const next = new Set(current);
      for (const id of removedThreadIds) {
        next.delete(id);
      }
      for (const id of running) {
        next.add(id);
      }
      return next;
    });
  }, []);

  // A retained thread absent from the loaded threads was deleted (or the store
  // was reset by Clear Database): its panel goes with it.
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
