import { type RefObject, useCallback } from 'react';
import type { ImperativePanelHandle } from 'react-resizable-panels';

interface UsePanelToggleOptions {
  focusRef?: RefObject<HTMLElement | null>;
  // Callback invoked on user-initiated actions to lift any initialization gate
  liftInitGate?: () => void;
  // Optional callback before toggling visibility (useful when panel is unmounted)
  onBeforeShow?: () => void;
  onBeforeHide?: () => void;
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

function expandPanel(ref: RefObject<ImperativePanelHandle | null>) {
  try {
    const handle = ref.current;
    if (handle && typeof handle.expand === 'function') handle.expand();
  } catch {
    // ignore impl errors
  }
}

function collapsePanel(ref: RefObject<ImperativePanelHandle | null>) {
  try {
    const handle = ref.current;
    if (handle && typeof handle.collapse === 'function') handle.collapse();
  } catch {
    // ignore impl errors
  }
}

function focusAfterAnimation(ref?: RefObject<HTMLElement | null>) {
  if (!ref) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      ref.current?.focus();
    });
  });
}

export function usePanelToggle(
  panelRef: RefObject<ImperativePanelHandle | null>,
  toggleFn: () => void,
  options: UsePanelToggleOptions = {}
) {
  const show = useCallback(() => {
    liftInitGate(options.liftInitGate);
    safeCall(options.onBeforeShow);
    expandPanel(panelRef);
    toggleFn();
    focusAfterAnimation(options.focusRef);
  }, [panelRef, toggleFn, options.liftInitGate, options.onBeforeShow, options.focusRef]);

  const hide = useCallback(() => {
    liftInitGate(options.liftInitGate);
    safeCall(options.onBeforeHide);
    collapsePanel(panelRef);
    toggleFn();
  }, [panelRef, toggleFn, options.liftInitGate, options.onBeforeHide]);

  return { show, hide };
}
