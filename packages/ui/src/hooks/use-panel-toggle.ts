import { type RefObject, useCallback } from 'react';
import type { ImperativePanelHandle } from 'react-resizable-panels';

interface UsePanelToggleOptions {
  focusRef?: RefObject<HTMLElement | null>;
  // Callback invoked on user-initiated actions to lift any initialization gate
  liftInitGate?: () => void;
}

export function usePanelToggle(
  panelRef: RefObject<ImperativePanelHandle | null>,
  toggleFn: () => void,
  options: UsePanelToggleOptions = {}
) {
  const show = useCallback(() => {
    if (options.liftInitGate) {
      options.liftInitGate();
    }
    try {
      if (panelRef.current) {
        if (typeof panelRef.current.expand === 'function') panelRef.current.expand();
      }
    } catch (_err) {
      // Ignore errors from panel impl during tests or init races
    }
    toggleFn();
    if (options.focusRef) {
      // Use rAF sequencing to focus after the expand/collapse animation frame
      // This is more deterministic than a fixed timeout and avoids test flakiness
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          options.focusRef?.current?.focus();
        });
      });
    }
  }, [panelRef, toggleFn, options.focusRef, options.liftInitGate]);

  const hide = useCallback(() => {
    if (options.liftInitGate) {
      options.liftInitGate();
    }
    try {
      if (panelRef.current) {
        if (typeof panelRef.current.collapse === 'function') panelRef.current.collapse();
      }
    } catch (_err) {
      // Ignore collapse errors (e.g., panel not fully initialized)
    }
    toggleFn();
  }, [panelRef, toggleFn, options.liftInitGate]);

  return { show, hide };
}
