import { useEffect, useRef } from 'react';

/**
 * Invoke `triggerResync` whenever the document transitions from hidden to
 * visible.
 *
 * Why this exists: a backfill canceled while the window is hidden (e.g. a
 * top-level navigation tearing down the renderer that requested it mid-run) has
 * no re-request path until the next sync cycle — and a freshly reloaded,
 * background-throttled window may never start one. Returning to visibility is
 * the reliable recovery point: the re-triggered sync's 0-changes branch runs the
 * coverage check and re-enqueues the missing embedding work.
 *
 * Transition-edge only: nothing fires on mount (whatever the initial
 * visibility), and the latest callback is used when the edge fires.
 */
export function useResyncOnReturnToVisibility(triggerResync: () => void): void {
  const triggerResyncRef = useRef(triggerResync);
  triggerResyncRef.current = triggerResync;

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    let wasVisible = document.visibilityState === 'visible';
    const handleVisibilityChange = (): void => {
      const visible = document.visibilityState === 'visible';
      const returnedToVisibility = visible && !wasVisible;
      wasVisible = visible;
      if (returnedToVisibility) {
        triggerResyncRef.current();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);
}
