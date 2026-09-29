import { useEventCallback } from '@brainstrike/hooks';
import { type RefObject, useRef } from 'react';
import {
  type ContextMenuTargetController,
  useContextMenuTarget,
} from '../context-menu/action-context-menu';
import { findTab, focusFirstTrailingControl } from './tab-strip-dom';
import type { TabStripContextMenu } from './types';

export interface TabStripMenu {
  readonly controller: ContextMenuTargetController;
  readonly handleStripContextMenu: () => void;
  readonly handleStripContextMenuCapture: () => void;
  readonly handleTabContextMenu: (id: string) => void;
  readonly openContextMenu: (id: string) => void;
  readonly restoreFocusAfterMenu: () => void;
}

/**
 * The context-action claiming protocol for one strip (ui-conventions CONTEXT
 * ACTION SYSTEM): reset in capture, a tab claims its target synchronously in
 * the same event, and the strip background claims only when no tab did.
 * Focus returns to the menu's origin tab, else the active or tab-stop tab, else
 * the first trailing control, else the tablist itself — never `body`.
 */
export function useTabStripMenu({
  activeId,
  contextMenu,
  rootRef,
  tablistRef,
  tabStopId,
  trailingRef,
}: {
  readonly activeId: string | null;
  readonly contextMenu: TabStripContextMenu | undefined;
  readonly rootRef: RefObject<HTMLElement | null>;
  /** Focus target of last resort (tabIndex=-1): never let focus fall to body. */
  readonly tablistRef: RefObject<HTMLElement | null>;
  readonly tabStopId: string | null;
  readonly trailingRef: RefObject<HTMLElement | null>;
}): TabStripMenu {
  const controller = useContextMenuTarget();
  const { setTarget } = controller;
  const menuOriginRef = useRef<string | null>(null);
  const claimedThisEventRef = useRef(false);

  const handleTabContextMenu = useEventCallback((id: string): void => {
    claimedThisEventRef.current = true;
    menuOriginRef.current = id;
    setTarget(contextMenu?.getTabTarget(id) ?? null);
  });
  const handleStripContextMenuCapture = useEventCallback((): void => {
    claimedThisEventRef.current = false;
    setTarget(null);
  });
  const handleStripContextMenu = useEventCallback((): void => {
    if (claimedThisEventRef.current || !contextMenu?.getStripTarget) {
      return;
    }
    menuOriginRef.current = null;
    setTarget(contextMenu.getStripTarget());
  });
  const openContextMenu = useEventCallback((id: string): void => {
    const element = findTab(rootRef.current, id);
    if (!element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    // Keyboard-invoked menus anchor at the tab, never at a (0,0) pointer.
    element.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        button: 2,
        cancelable: true,
        clientX: rect.left,
        clientY: rect.bottom,
      })
    );
  });
  // ActionContextMenu prevents Radix's default close-autofocus before calling this.
  const restoreFocusAfterMenu = useEventCallback((): void => {
    const root = rootRef.current;
    const origin = menuOriginRef.current;
    const candidate =
      (origin === null ? null : findTab(root, origin)) ??
      (activeId === null ? null : findTab(root, activeId)) ??
      (tabStopId === null ? null : findTab(root, tabStopId));
    if (candidate) {
      candidate.focus();
      return;
    }
    if (!focusFirstTrailingControl(trailingRef.current)) {
      tablistRef.current?.focus();
    }
  });

  return {
    controller,
    handleStripContextMenu,
    handleStripContextMenuCapture,
    handleTabContextMenu,
    openContextMenu,
    restoreFocusAfterMenu,
  };
}
