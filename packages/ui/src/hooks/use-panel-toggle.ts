import { type RefObject, useCallback } from 'react';

interface UsePanelToggleOptions {
  focusRef?: RefObject<HTMLElement | null>;
  // Callback invoked on user-initiated actions to lift any initialization gate
  liftInitGate?: () => void;
  onBeforeHide?: () => void;
  // Optional callback before toggling visibility (useful when panel is unmounted)
  onBeforeShow?: () => void;
}

function liftInitGate(fn?: () => void) {
  fn?.();
}

function safeCall(fn?: () => void) {
  try {
    fn?.();
  } catch {
    // ignore
  }
}

// Note: In react-resizable-panels v4, panels are conditionally rendered.
// We no longer call expand()/collapse() imperatively because:
// 1. These methods trigger onLayoutChange/onLayoutChanged events
// 2. Combined with state updates, this can cause infinite loops (React error #185)
// 3. With conditional rendering, panels mount/unmount based on visibility state

function focusAfterAnimation(ref?: RefObject<HTMLElement | null>) {
  if (!ref) {
    return;
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      ref.current?.focus();
    });
  });
}

export function usePanelToggle(toggleFn: () => void, options: UsePanelToggleOptions = {}) {
  const show = useCallback(() => {
    liftInitGate(options.liftInitGate);
    safeCall(options.onBeforeShow);
    // Panel visibility is controlled via conditional rendering, not expand()
    toggleFn();
    focusAfterAnimation(options.focusRef);
  }, [toggleFn, options.liftInitGate, options.onBeforeShow, options.focusRef]);

  const hide = useCallback(() => {
    liftInitGate(options.liftInitGate);
    safeCall(options.onBeforeHide);
    // Panel visibility is controlled via conditional rendering, not collapse()
    toggleFn();
  }, [toggleFn, options.liftInitGate, options.onBeforeHide]);

  return { hide, show };
}
