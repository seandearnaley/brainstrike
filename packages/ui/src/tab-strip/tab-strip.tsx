import type { AnyContextAction } from '@brainstrike/context-actions';
import { useEventCallback } from '@brainstrike/hooks';
import {
  type ReactElement,
  type ReactNode,
  type RefObject,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActionContextMenu,
  type ContextMenuTargetController,
} from '../context-menu/action-context-menu';
import { cn } from '../lib/utils';
import { TabPanelBoundary } from './tab-panel-boundary';
import { TabStripAllTabsMenu } from './tab-strip-all-tabs-menu';
import {
  handleTabStripKeyDown,
  handleTabStripKeyUp,
  type TabStripKeyboardContext,
} from './tab-strip-keyboard';
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
import { useMenuOpenReporter } from './use-menu-open-reporter';
import { useTabStripFocus } from './use-tab-strip-focus';
import { useTabStripMenu } from './use-tab-strip-menu';
import { tabStripOverflowMaskStyle, useTabStripOverflow } from './use-tab-strip-overflow';

const EMPTY_ITEMS: readonly TabStripItem[] = [];

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

/** Consumer controls (New, Add) followed by the All-tabs overflow menu. */
function TabStripTrailing({
  activeId,
  allItems,
  allTabsMenu,
  children,
  onActivate,
  onCloseAll,
  onMenuOpenChange,
  ref,
}: {
  readonly activeId: string | null;
  readonly allItems: readonly TabStripItem[];
  readonly allTabsMenu: boolean;
  readonly children: ReactNode;
  readonly onActivate: (id: string) => void;
  readonly onCloseAll: (() => void) | undefined;
  readonly onMenuOpenChange: ((open: boolean) => void) | undefined;
  readonly ref: RefObject<HTMLDivElement | null>;
}): ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-1" data-slot="tab-strip-trailing" ref={ref}>
      {children}
      {allTabsMenu && allItems.length > 0 ? (
        <TabStripAllTabsMenu
          activeId={activeId}
          items={allItems}
          onActivate={onActivate}
          onCloseAll={onCloseAll}
          onOpenChange={onMenuOpenChange}
        />
      ) : null}
    </div>
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
  const tablistRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState('');

  const allItems = useMemo(() => [...pinnedItems, ...items], [items, pinnedItems]);
  const allIds = useMemo(() => allItems.map((item) => item.id), [allItems]);
  const scrollIds = useMemo(() => items.map((item) => item.id), [items]);
  const reorderableIds = useMemo(
    () => items.flatMap((item) => (item.reorderable === false ? [] : [item.id])),
    [items]
  );
  const tabStopId = activeId !== null && allIds.includes(activeId) ? activeId : (allIds[0] ?? null);

  const overflow = useTabStripOverflow(scrollRef, scrollIds.join('\n'));
  const reorderInstanceId = useTabReorderInstanceId(onReorder !== undefined);
  useTabStripReorderMonitor({
    instanceId: reorderInstanceId,
    onReorder,
    orderedIds: reorderableIds,
    scrollRef,
  });
  const focus = useTabStripFocus({ activeId, rootRef, tablistRef, trailingRef });
  const menu = useTabStripMenu({
    activeId,
    contextMenu,
    rootRef,
    tablistRef,
    tabStopId,
    trailingRef,
  });

  const handleActivate = useEventCallback((id: string): void => onActivate(id));
  const handleCloseStable = useEventCallback((id: string): void => onClose?.(id));
  const handleClose = onClose ? handleCloseStable : null;
  const handlePointerCloseStable = useEventCallback((id: string): void => {
    onClose?.(id);
    focus.focusAfterPointerClose();
  });
  const handlePointerClose = onClose ? handlePointerCloseStable : null;
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

  const keyboard: TabStripKeyboardContext = {
    allIds,
    announce,
    close: handleClose,
    focusFallback: focus.focusFallback,
    focusTab: focus.focusTab,
    focusTabAfterCommit: focus.focusTabAfterCommit,
    hasContextMenu: contextMenu !== undefined,
    isClosable,
    labelOf,
    openContextMenu: menu.openContextMenu,
    reorder: onReorder ?? null,
    reorderableIds,
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
      onClose={handlePointerClose}
      onContextMenu={menu.handleTabContextMenu}
      reorderInstanceId={
        group === 'scroll' && item.reorderable !== false ? reorderInstanceId : null
      }
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
      onContextMenu={menu.handleStripContextMenu}
      onContextMenuCapture={menu.handleStripContextMenuCapture}
      ref={rootRef}
    >
      {leading}
      <div
        aria-label={ariaLabel}
        aria-orientation="horizontal"
        className="flex h-full min-w-0 flex-1 items-center"
        onFocus={focus.handleTablistFocus}
        onKeyDown={(event) => handleTabStripKeyDown(event, keyboard)}
        onKeyUp={(event) => handleTabStripKeyUp(event, keyboard)}
        onPointerDown={focus.handleTablistPointerDown}
        ref={tablistRef}
        role="tablist"
        tabIndex={-1}
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
      <TabStripTrailing
        activeId={activeId}
        allItems={allItems}
        allTabsMenu={allTabsMenu}
        onActivate={handleActivate}
        onCloseAll={onCloseAll}
        onMenuOpenChange={onMenuOpenChange}
        ref={trailingRef}
      >
        {trailing}
      </TabStripTrailing>
      <div aria-live="polite" className="sr-only" role="status">
        {announcement}
      </div>
    </div>
  );

  if (!contextMenu) {
    return strip;
  }
  return (
    <TabStripContextMenuHost
      controller={menu.controller}
      localActions={contextMenu.localActions}
      onCloseAutoFocus={menu.restoreFocusAfterMenu}
      onMenuOpenChange={onMenuOpenChange}
    >
      {strip}
    </TabStripContextMenuHost>
  );
}

/**
 * Owns the context menu's open reporter so it unmounts WITH the menu: dropping
 * `contextMenu` (or unmounting the strip) while the menu is open still reports
 * the close a native-view host is waiting for.
 */
function TabStripContextMenuHost({
  children,
  controller,
  localActions,
  onCloseAutoFocus,
  onMenuOpenChange,
}: {
  readonly children: ReactNode;
  readonly controller: ContextMenuTargetController;
  readonly localActions: readonly AnyContextAction[];
  readonly onCloseAutoFocus: () => void;
  readonly onMenuOpenChange: ((open: boolean) => void) | undefined;
}): ReactElement {
  const reportOpenChange = useMenuOpenReporter(onMenuOpenChange);
  return (
    <ActionContextMenu
      controller={controller}
      localActions={localActions}
      onCloseAutoFocus={onCloseAutoFocus}
      onOpenChange={reportOpenChange}
    >
      {children}
    </ActionContextMenu>
  );
}
