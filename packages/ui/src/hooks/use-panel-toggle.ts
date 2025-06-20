import { type RefObject, useCallback } from 'react';
import type { ImperativePanelHandle } from 'react-resizable-panels';

interface UsePanelToggleOptions {
  focusRef?: RefObject<HTMLElement | null>;
}

export function usePanelToggle(
  panelRef: RefObject<ImperativePanelHandle | null>,
  toggleFn: () => void,
  options: UsePanelToggleOptions = {}
) {
  const show = useCallback(() => {
    if (panelRef.current) {
      panelRef.current.expand();
    }
    toggleFn();
    if (options.focusRef) {
      setTimeout(() => {
        options.focusRef?.current?.focus();
      }, 100);
    }
  }, [panelRef, toggleFn, options.focusRef]);

  const hide = useCallback(() => {
    if (panelRef.current) {
      panelRef.current.collapse();
    }
    toggleFn();
  }, [panelRef, toggleFn]);

  return { show, hide };
}
