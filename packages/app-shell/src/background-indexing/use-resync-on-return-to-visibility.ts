import { useEffect, useRef } from 'react';

/**
 * How long the document must REMAIN visible after a hidden → visible
 * transition before a resync fires. `visibilitychange` edges are frequent in
 * normal use (alt-tab, space switches, minimize/restore); firing per edge
 * would abort and restart the renderer-side scan each time. The settle window
 * collapses a burst of focus flips into at most one resync, and a flip back
 * to hidden cancels the pending one. The recovery case this hook exists for
 * (a backfill killed by a mid-run teardown while hidden) only needs a resync
 * on a SUSTAINED return, so the delay costs nothing real.
 */
export const RESYNC_ON_VISIBILITY_SETTLE_MS = 3000;

/**
 * Invoke `triggerResync` after the document transitions from hidden to visible
 * and stays visible for {@link RESYNC_ON_VISIBILITY_SETTLE_MS}.
 *
 * Why this exists: a backfill canceled while the window is hidden (e.g. a
 * top-level navigation tearing down the renderer that requested it mid-run) has
 * no re-request path until the next sync cycle — and a freshly reloaded,
 * background-throttled window may never start one. Returning to visibility is
 * the reliable recovery point: the re-triggered sync's 0-changes branch runs the
 * coverage check and re-enqueues the missing embedding work. (An in-flight
 * main-process backfill is NOT cancelled by the re-triggered sync — `sync()`
 * re-attaches via `selectRecoverableBackgroundBackfill`; only the renderer-side
 * scan restarts.)
 *
 * Transition-edge only: nothing fires on mount (whatever the initial
 * visibility), and the latest callback is used when the settled edge fires.
 */
export function useResyncOnReturnToVisibility(triggerResync: () => void): void {
  const triggerResyncRef = useRef(triggerResync);
  triggerResyncRef.current = triggerResync;

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    let wasVisible = document.visibilityState === 'visible';
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const clearSettleTimer = (): void => {
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
    };
    const handleVisibilityChange = (): void => {
      const visible = document.visibilityState === 'visible';
      const returnedToVisibility = visible && !wasVisible;
      wasVisible = visible;
      if (!visible) {
        // Hidden again before settling: the return was a flicker, drop it.
        clearSettleTimer();
        return;
      }
      if (!returnedToVisibility) {
        return;
      }
      clearSettleTimer();
      settleTimer = setTimeout(() => {
        settleTimer = null;
        triggerResyncRef.current();
      }, RESYNC_ON_VISIBILITY_SETTLE_MS);
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      clearSettleTimer();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);
}
