import { useEventCallback } from '@brainstrike/hooks';
import { type FocusEvent, type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { ActionContextMenu, useContextMenuTarget } from '../context-menu';
import { cn } from '../lib/utils';
import { TabPanelBoundary } from './tab-panel-boundary';
import { TabStripAllTabsMenu } from './tab-strip-all-tabs-menu';
import { handleTabStripKeyDown, type TabStripKeyboardContext } from './tab-strip-keyboard';
import { useTabReorderInstanceId, useTabStripReorderMonitor } from './tab-strip-reorder';
import { type TabStripGroup, TabStripTab } from './tab-strip-tab';
import {
  TAB_STRIP_EMBEDDED_CLASS_NAME,
  TAB_STRIP_GROUP_SEPARATOR_CLASS_NAME,
  TAB_STRIP_ROOT_CLASS_NAME,
  TAB_STRIP_SCROLLER_CLASS_NAME,
  TAB_STRIP_STANDALONE_CLASS_NAME,
} from './tab-strip-tokens';
import type { TabStripItem, TabStripProps } from './types';
import { tabStripOverflowMaskStyle, useTabStripOverflow } from './use-tab-strip-overflow';

const EMPTY_ITEMS: readonly TabStripItem[] = [];

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)')?.matches === true
  );
}

function findTab(root: HTMLElement | null, id: string): HTMLElement | null {
  if (!root) {
    return null;
  }
  for (const element of root.querySelectorAll<HTMLElement>('[role="tab"][data-strip-tab-id]')) {
    if (element.dataset['stripTabId'] === id) {
      return element;
    }
  }
  return null;
}

function revealTab(tab: HTMLElement | null, smooth: boolean): void {
  const shell = tab?.closest<HTMLElement>('[data-slot="tab-shell"]');
  // scrollIntoView is absent from unit-test DOM shims only.
  if (!shell || typeof shell.scrollIntoView !== 'function') {
    return;
  }
  shell.scrollIntoView({
    behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto',
    block: 'nearest',
    inline: 'nearest',
  });
}

function focusFirstTrailingControl(trailing: HTMLElement | null): void {
  trailing?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
}

/**
 * The one tab strip (BST-1836). Presentational: data in, intents out. A render
 * crash anywhere inside degrades to an inline "Tabs unavailable — Retry" row.
 */
export function TabStrip(props: TabStripProps): ReactElement {
  return (
    <TabPanelBoundary label="Tabs" layout="inline">
      <TabStripContent {...props} />
    </TabPanelBoundary>
  );
}

function TabStripContent({
  activeId,
  allTabsMenu = true,
  'aria-label': ariaLabel,
  chrome = 'standalone',
  contextMenu,
  items,
  leading,
  onActivate,
  onClose,
  onCloseAll,
  onMenuOpenChange,
  onReorder,
  pinnedItems = EMPTY_ITEMS,
  scrollTestId,
  testId,
  trailing,
}: TabStripProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLDivElement>(null);
  const menuOriginRef = useRef<string | null>(null);
  const claimedThisEventRef = useRef(false);
  const controller = useContextMenuTarget();
  const { setTarget } = controller;
  const [announcement, setAnnouncement] = useState('');

  const allItems = useMemo(() => [...pinnedItems, ...items], [items, pinnedItems]);
  const allIds = useMemo(() => allItems.map((item) => item.id), [allItems]);
  const scrollIds = useMemo(() => items.map((item) => item.id), [items]);
  const tabStopId = activeId !== null && allIds.includes(activeId) ? activeId : (allIds[0] ?? null);

  const overflow = useTabStripOverflow(scrollRef, scrollIds.join('\n'));
  const reorderInstanceId = useTabReorderInstanceId(onReorder !== undefined);
  useTabStripReorderMonitor({
    instanceId: reorderInstanceId,
    onReorder,
    orderedIds: scrollIds,
    scrollRef,
  });

  const handleActivate = useEventCallback((id: string): void => onActivate(id));
  const handleCloseStable = useEventCallback((id: string): void => onClose?.(id));
  const handleClose = onClose ? handleCloseStable : null;
  const handleTabContextMenu = useEventCallback((id: string): void => {
    claimedThisEventRef.current = true;
    menuOriginRef.current = id;
    setTarget(contextMenu?.getTabTarget(id) ?? null);
  });
  const handleStripContextMenuCapture = (): void => {
    claimedThisEventRef.current = false;
    setTarget(null);
  };
  const handleStripContextMenu = (): void => {
    if (claimedThisEventRef.current || !contextMenu?.getStripTarget) {
      return;
    }
    menuOriginRef.current = null;
    setTarget(contextMenu.getStripTarget());
  };

  const focusTab = useEventCallback((id: string): void => {
    const element = findTab(rootRef.current, id);
    element?.focus();
    revealTab(element, false);
  });
  const focusTabAfterCommit = useEventCallback((id: string): void => {
    window.requestAnimationFrame(() => focusTab(id));
  });
  const focusFallback = useEventCallback((): void => {
    window.requestAnimationFrame(() => focusFirstTrailingControl(trailingRef.current));
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
    focusFirstTrailingControl(trailingRef.current);
  });
  const announce = useEventCallback((message: string): void => {
    // A live region only announces changes; alternate a trailing NBSP for repeats.
    setAnnouncement((current) => (current === message ? `${message} ` : message));
  });
  const labelOf = useEventCallback(
    (id: string): string => allItems.find((item) => item.id === id)?.label ?? id
  );
  const isClosable = useEventCallback(
    (id: string): boolean => allItems.find((item) => item.id === id)?.closable === true
  );

  // biome-ignore lint/plugin: imperative scroll-into-view synced to a prop that changes from outside the strip (store, All-tabs menu), not a state-as-event-handler effect
  useEffect(() => {
    if (activeId !== null) {
      revealTab(findTab(rootRef.current, activeId), true);
    }
  }, [activeId]);

  const keyboard: TabStripKeyboardContext = {
    allIds,
    announce,
    close: handleClose,
    focusFallback,
    focusTab,
    focusTabAfterCommit,
    hasContextMenu: contextMenu !== undefined,
    isClosable,
    labelOf,
    openContextMenu,
    reorder: onReorder ?? null,
    reorderableIds: scrollIds,
  };

  const handleTablistFocus = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLElement && event.target.matches('[role="tab"]')) {
      revealTab(event.target, false);
    }
  };

  const renderTab = (item: TabStripItem, group: TabStripGroup): ReactElement => (
    <TabStripTab
      group={group}
      hasContextMenu={contextMenu !== undefined}
      isActive={item.id === activeId}
      isTabStop={item.id === tabStopId}
      item={item}
      key={item.id}
      onActivate={handleActivate}
      onClose={handleClose}
      onContextMenu={handleTabContextMenu}
      reorderInstanceId={group === 'scroll' ? reorderInstanceId : null}
    />
  );

  const strip = (
    // biome-ignore lint/a11y/noStaticElementInteractions: layout container; it only claims the strip-background context-menu target
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: see above
    <div
      className={cn(
        TAB_STRIP_ROOT_CLASS_NAME,
        chrome === 'standalone' ? TAB_STRIP_STANDALONE_CLASS_NAME : TAB_STRIP_EMBEDDED_CLASS_NAME
      )}
      data-slot="tab-strip"
      data-testid={testId}
      onContextMenu={handleStripContextMenu}
      onContextMenuCapture={handleStripContextMenuCapture}
      ref={rootRef}
    >
      {leading}
      <div
        aria-label={ariaLabel}
        aria-orientation="horizontal"
        className="flex h-full min-w-0 flex-1 items-center"
        onFocus={handleTablistFocus}
        onKeyDown={(event) => handleTabStripKeyDown(event, keyboard)}
        role="tablist"
      >
        {pinnedItems.length > 0 ? (
          <div className="flex shrink-0 items-center gap-1" data-group="pinned" role="presentation">
            {pinnedItems.map((item) => renderTab(item, 'pinned'))}
          </div>
        ) : null}
        {pinnedItems.length > 0 && items.length > 0 ? (
          <div aria-hidden="true" className={TAB_STRIP_GROUP_SEPARATOR_CLASS_NAME} />
        ) : null}
        <div
          className={TAB_STRIP_SCROLLER_CLASS_NAME}
          data-group="scroll"
          data-overflow-end={overflow.end ? 'true' : undefined}
          data-overflow-start={overflow.start ? 'true' : undefined}
          data-testid={scrollTestId}
          ref={scrollRef}
          role="presentation"
          style={tabStripOverflowMaskStyle(overflow)}
        >
          <div className="flex w-max items-center gap-1" role="presentation">
            {items.map((item) => renderTab(item, 'scroll'))}
          </div>
        </div>
      </div>
      <div
        className="flex shrink-0 items-center gap-1"
        data-slot="tab-strip-trailing"
        ref={trailingRef}
      >
        {trailing}
        {allTabsMenu && allItems.length > 0 ? (
          <TabStripAllTabsMenu
            activeId={activeId}
            items={allItems}
            onActivate={handleActivate}
            onCloseAll={onCloseAll}
            onOpenChange={onMenuOpenChange}
          />
        ) : null}
      </div>
      <div aria-live="polite" className="sr-only" role="status">
        {announcement}
      </div>
    </div>
  );

  if (!contextMenu) {
    return strip;
  }
  return (
    <ActionContextMenu
      controller={controller}
      localActions={contextMenu.localActions}
      onCloseAutoFocus={restoreFocusAfterMenu}
      {...(onMenuOpenChange ? { onOpenChange: onMenuOpenChange } : {})}
    >
      {strip}
    </ActionContextMenu>
  );
}
