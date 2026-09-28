import { useEventCallback } from '@brainstrike/hooks';
import { type FocusEvent, type RefObject, useEffect, useRef } from 'react';
import { findTab, focusFirstTrailingControl, revealTab } from './tab-strip-dom';

export interface TabStripFocus {
  readonly focusFallback: () => void;
  readonly focusTab: (id: string) => void;
  readonly focusTabAfterCommit: (id: string) => void;
  readonly handleTablistFocus: (event: FocusEvent<HTMLDivElement>) => void;
  readonly handleTablistPointerDown: () => void;
}

/**
 * Focus movement and reveal for one strip. A tab is scrolled into view when it
 * becomes active or gains KEYBOARD focus; pointer focus never scrolls, so a
 * press that starts a drag does not move the tab out from under the pointer.
 */
export function useTabStripFocus({
  activeId,
  rootRef,
  tablistRef,
  trailingRef,
}: {
  readonly activeId: string | null;
  readonly rootRef: RefObject<HTMLElement | null>;
  /** Focus target of last resort (tabIndex=-1): never let focus fall to body. */
  readonly tablistRef: RefObject<HTMLElement | null>;
  readonly trailingRef: RefObject<HTMLElement | null>;
}): TabStripFocus {
  const pointerFocusRef = useRef(false);
  const hasRevealedRef = useRef(false);

  const focusTab = useEventCallback((id: string): void => {
    const element = findTab(rootRef.current, id);
    element?.focus();
    revealTab(element, false);
  });
  const focusTabAfterCommit = useEventCallback((id: string): void => {
    window.requestAnimationFrame(() => focusTab(id));
  });
  const focusFallback = useEventCallback((): void => {
    window.requestAnimationFrame(() => {
      if (!focusFirstTrailingControl(trailingRef.current)) {
        tablistRef.current?.focus();
      }
    });
  });
  const handleTablistPointerDown = useEventCallback((): void => {
    pointerFocusRef.current = true;
  });
  const handleTablistFocus = useEventCallback((event: FocusEvent<HTMLDivElement>): void => {
    const fromPointer = pointerFocusRef.current;
    pointerFocusRef.current = false;
    if (fromPointer) {
      return;
    }
    if (event.target instanceof HTMLElement && event.target.matches('[role="tab"]')) {
      revealTab(event.target, false);
    }
  });

  // Imperative scroll-into-view synced to a prop that changes from outside the
  // strip (store, All-tabs menu).
  useEffect(() => {
    if (activeId === null) {
      return;
    }
    // The first reveal (mount) jumps; later activations animate.
    revealTab(findTab(rootRef.current, activeId), hasRevealedRef.current);
    hasRevealedRef.current = true;
  }, [activeId, rootRef]);

  return {
    focusFallback,
    focusTab,
    focusTabAfterCommit,
    handleTablistFocus,
    handleTablistPointerDown,
  };
}
