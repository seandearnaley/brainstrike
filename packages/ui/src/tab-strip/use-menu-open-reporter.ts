import { useEventCallback } from '@brainstrike/hooks';
import { useEffect, useRef } from 'react';

/**
 * Reports a menu's open state to a host with a PAIRING guarantee: every
 * reported `true` is followed by exactly one `false` — repeated reports of the
 * same state are dropped, and a menu that unmounts while open (Radix reports
 * nothing then) reports its close from cleanup. Hosts that occlude a native
 * view (the browser pane) count on this pairing, or the view stays hidden.
 */
export function useMenuOpenReporter(
  onOpenChange: ((open: boolean) => void) | undefined
): (open: boolean) => void {
  const openRef = useRef(false);
  const report = useEventCallback((open: boolean): void => {
    if (openRef.current === open) {
      return;
    }
    openRef.current = open;
    onOpenChange?.(open);
  });
  // biome-ignore lint/plugin: unmount cleanup notifying an external host (native-view occlusion), not state used as an event handler
  useEffect(() => () => report(false), [report]);
  return report;
}
