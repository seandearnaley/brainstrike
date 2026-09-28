import { useEventCallback } from '@brainstrike/hooks';
import { type FocusEvent, type RefObject, useEffect, useRef } from 'react';
import {
  findSelectedTab,
  findTab,
  focusFirstTrailingControl,
  isFocusLost,
  revealTab,
} from './tab-strip-dom';

export interface TabStripFocus {
  readonly focusAfterPointerClose: () => void;
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
  const focusFallbackNow = (): void => {
    if (!focusFirstTrailingControl(trailingRef.current)) {
      tablistRef.current?.focus();
    }
  };
  const focusFallback = useEventCallback((): void => {
    window.requestAnimationFrame(focusFallbackNow);
  });
  // The ✕ and middle-click never take focus, but closing the active tab
  // unmounts its panel: focus inside it falls to body. Only then move it to the
  // newly selected tab; focus that survived the close stays where it is.
  const focusAfterPointerClose = useEventCallback((): void => {
    window.requestAnimationFrame(() => {
      if (!isFocusLost()) {
        return;
      }
      const selected = findSelectedTab(rootRef.current);
      if (selected) {
        selected.focus();
        return;
      }
      focusFallbackNow();
    });
  });
  const handleTablistPointerDown = useEventCallback((): void => {
    // Focus from a press lands in the same task as pointerdown; clear the flag
    // on the next frame so a press that yields NO focus (the mouse-only close
    // button, Safari buttons) cannot suppress a later keyboard reveal.
    pointerFocusRef.current = true;
    window.requestAnimationFrame(() => {
      pointerFocusRef.current = false;
    });
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
    focusAfterPointerClose,
    focusFallback,
    focusTab,
    focusTabAfterCommit,
    handleTablistFocus,
    handleTablistPointerDown,
  };
}
