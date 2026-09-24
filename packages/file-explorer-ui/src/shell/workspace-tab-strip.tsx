import { type AnyContextAction, defineContextAction } from '@brainstrike/context-actions';
import type { TabFileStatus } from '@brainstrike/file-explorer-hooks';
import { createLogger } from '@brainstrike/logging';
import {
  ActionContextMenu,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  useContextMenuTarget,
} from '@brainstrike/ui';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  File,
  Loader2,
  LockKeyhole,
  MoreHorizontal,
  X,
} from 'lucide-react';
import {
  type KeyboardEvent,
  memo,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { fileTabToTarget } from '../context-actions/file-surface-target';
import type { FileTab } from '../hooks/use-tab-manager';
import { useTabManagerStore } from '../stores/tab-manager-store';
import { useWorkspaceTabs } from './use-workspace-tabs';
import { WorkspaceAddTabMenu } from './workspace-add-tab-menu';
import type { WorkspaceApp } from './workspace-app';
import { getFileName, getTabRootPath } from './workspace-tab-utils';

const logger = createLogger('WorkspaceTabStrip');

/**
 * The single workspace tab strip (BST-1258): closable singleton app tabs
 * (pill treatment) followed by file tabs, rendered in the workspace panel's
 * HEADER row via IdeLayout's `headerContent` seam. All state comes from
 * `useWorkspaceTabs()` — strip and body live in sibling subtrees.
 *
 * Scroll contract: no visible scrollbar; wheel input scrolls horizontally;
 * chevron buttons appear only when content overflows; the active tab scrolls
 * into view on selection (reduced-motion aware).
 */
export function WorkspaceTabStrip(): ReactElement {
  const {
    apps,
    getTabStatusMessage,
    loadingFiles,
    onCloseAllFileTabs,
    onCloseApp,
    onCloseFileTab,
    onCloseFileTabsToRight,
    onCloseOtherFileTabs,
    onOpenApp,
    onSelectFileTab,
    openApps,
    rootDescriptors,
    selection,
    tabs,
    tabStatuses,
  } = useWorkspaceTabs();

  const contextMenuController = useContextMenuTarget();
  const { setTarget: setContextMenuTarget } = contextMenuController;
  const handleFileTabContextMenu = useCallback(
    (tab: FileTab): void => {
      const target = fileTabToTarget(tab, getTabRootPath(tab, rootDescriptors));
      if (!target) {
        logger.error('Could not resolve workspace file tab context target', {
          compositeKey: tab.compositeKey,
        });
      }
      setContextMenuTarget(target);
    },
    [rootDescriptors, setContextMenuTarget]
  );

  const localActions = useMemo<readonly AnyContextAction[]>(() => {
    const currentTabs = (): readonly FileTab[] => useTabManagerStore.getState().tabs;
    const currentTargetIndex = (tabId: string): number =>
      currentTabs().findIndex((tab) => tab.id === tabId);
    const isCurrentTab = (tabId: string): boolean => currentTargetIndex(tabId) >= 0;
    const staleTargetFailure = Promise.resolve({
      error: 'File tab is no longer open',
      ok: false as const,
    });

    return [
      defineContextAction({
        appliesTo: ['workspace-file-tab'] as const,
        group: 'primary',
        icon: X,
        id: 'workspace-file-tab.close',
        isEnabled: (target) => isCurrentTab(target.tabId),
        label: 'Close',
        run: (target) => {
          if (!isCurrentTab(target.tabId)) {
            return staleTargetFailure;
          }
          onCloseFileTab(target.tabId);
          return Promise.resolve({ ok: true });
        },
      }),
      defineContextAction({
        appliesTo: ['workspace-file-tab'] as const,
        group: 'primary',
        id: 'workspace-file-tab.close-others',
        isEnabled: (target) => isCurrentTab(target.tabId) && currentTabs().length > 1,
        label: 'Close Others',
        run: (target) => {
          if (!isCurrentTab(target.tabId)) {
            return staleTargetFailure;
          }
          if (currentTabs().length <= 1) {
            return Promise.resolve({ error: 'No other file tabs remain open', ok: false });
          }
          onCloseOtherFileTabs(target.tabId);
          return Promise.resolve({ ok: true });
        },
      }),
      defineContextAction({
        appliesTo: ['workspace-file-tab'] as const,
        group: 'primary',
        id: 'workspace-file-tab.close-right',
        isEnabled: (target) => {
          const targetIndex = currentTargetIndex(target.tabId);
          return targetIndex >= 0 && targetIndex < currentTabs().length - 1;
        },
        label: 'Close Tabs to the Right',
        run: (target) => {
          const targetIndex = currentTargetIndex(target.tabId);
          if (targetIndex === -1) {
            return staleTargetFailure;
          }
          if (targetIndex === currentTabs().length - 1) {
            return Promise.resolve({ error: 'No file tabs remain to the right', ok: false });
          }
          onCloseFileTabsToRight(target.tabId);
          return Promise.resolve({ ok: true });
        },
      }),
      defineContextAction({
        appliesTo: ['workspace-file-tab'] as const,
        group: 'primary',
        id: 'workspace-file-tab.close-all',
        isEnabled: (target) => isCurrentTab(target.tabId),
        label: 'Close All Tabs',
        run: (target) => {
          if (!isCurrentTab(target.tabId)) {
            return staleTargetFailure;
          }
          onCloseAllFileTabs();
          return Promise.resolve({ ok: true });
        },
      }),
    ];
  }, [onCloseAllFileTabs, onCloseFileTab, onCloseFileTabsToRight, onCloseOtherFileTabs]);

  // ---- Overflow scrolling (mirrors assistant-thread-tabs-workspace.tsx) ----
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollState, setScrollState] = useState({ canScrollLeft: false, canScrollRight: false });

  const measureScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const canScrollLeft = el.scrollLeft > 1;
    const canScrollRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setScrollState((prev) =>
      prev.canScrollLeft === canScrollLeft && prev.canScrollRight === canScrollRight
        ? prev
        : { canScrollLeft, canScrollRight }
    );
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measureScroll);
    observer.observe(el);
    measureScroll();
    return () => observer.disconnect();
  }, [measureScroll]);

  // Re-measure when the tab population changes (opening many tabs overflows).
  useEffect(() => {
    measureScroll();
  }, [measureScroll, tabs.length, openApps.length]);

  const handleTabWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      el.scrollLeft += event.deltaY;
    }
  }, []);

  const scrollByAmount = useCallback((direction: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const amount = Math.max(120, Math.floor(el.clientWidth * 0.6));
    // scrollBy is missing in jsdom; fall back to a direct scrollLeft write.
    if (typeof el.scrollBy === 'function') {
      el.scrollBy({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        left: direction === 'left' ? -amount : amount,
      });
    } else {
      el.scrollLeft += direction === 'left' ? -amount : amount;
    }
  }, []);

  // Keep the active tab visible when the selection changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const active = el.querySelector<HTMLElement>('[aria-selected="true"]');
    // scrollIntoView is missing in jsdom; the strip degrades to manual scroll.
    active?.scrollIntoView?.({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  }, [selection]);

  // ---- Roving keyboard navigation over every role=tab in the strip ----
  // The tablist IS the scroller (see JSX note), so one node carries both refs.
  const mergedScrollTablistRef = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
  }, []);
  const handleTablistKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      dispatchTablistKey(event, scrollRef.current, { onCloseApp, onCloseFileTab });
    },
    [onCloseApp, onCloseFileTab]
  );

  const hasAnyTab = openApps.length > 0 || tabs.length > 0;

  return (
    <ActionContextMenu controller={contextMenuController} localActions={localActions}>
      <div
        className="flex h-full min-w-0 flex-1 items-stretch"
        data-testid="workspace-tab-strip"
        onContextMenuCapture={() => setContextMenuTarget(null)}
      >
        {hasAnyTab ? null : (
          <span className="flex items-center px-3 font-medium text-muted-foreground text-xs">
            Workspace
          </span>
        )}
        {scrollState.canScrollLeft ? (
          <Button
            aria-label="Scroll tabs left"
            className="my-auto h-6 w-6 flex-shrink-0 rounded-sm"
            data-testid="workspace-tabs-scroll-left"
            onClick={() => scrollByAmount('left')}
            size="icon"
            variant="ghost"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        ) : null}
        {/* role="tablist" lives on the tabs-only scroller: chevrons, the overflow
            menu, and per-tab close buttons are NOT tabs and must not be announced
            as tablist children (review finding, APG composition). */}
        <div
          aria-label="Workspace tabs"
          className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          data-testid="workspace-tab-scroll"
          onKeyDown={handleTablistKeyDown}
          onScroll={measureScroll}
          onWheel={handleTabWheel}
          ref={mergedScrollTablistRef}
          role="tablist"
        >
          <div className="flex flex-shrink-0 items-stretch gap-0.5">
            {openApps.map((app) => (
              <AppTabButton
                app={app}
                isActive={selection.kind === 'app' && selection.appId === app.id}
                key={app.id}
                onClose={onCloseApp}
                onSelect={onOpenApp}
              />
            ))}
          </div>
          {openApps.length > 0 && tabs.length > 0 ? (
            <div aria-hidden="true" className="mx-1 my-2 w-px flex-shrink-0 bg-border" />
          ) : null}
          {tabs.map((tab) => {
            const isActive = selection.kind === 'file' && selection.tabId === tab.id;
            const status = tabStatuses.get(tab.compositeKey);
            const isLoading = loadingFiles.has(tab.compositeKey);
            const statusMessage = getTabStatusMessage(tab.compositeKey);
            // FileTabButton receives the parent handlers verbatim and dispatches them with
            // its own tab.id internally — no per-render arrow-closure recreation, so the
            // memo wrap on FileTabButton bails on shallow-equal props.
            return (
              <FileTabButton
                isActive={isActive}
                isLoading={isLoading}
                key={tab.id}
                onClose={onCloseFileTab}
                onContextMenu={handleFileTabContextMenu}
                onSelect={onSelectFileTab}
                status={status}
                statusMessage={statusMessage}
                tab={tab}
              />
            );
          })}
        </div>
        {scrollState.canScrollRight ? (
          <Button
            aria-label="Scroll tabs right"
            className="my-auto h-6 w-6 flex-shrink-0 rounded-sm"
            data-testid="workspace-tabs-scroll-right"
            onClick={() => scrollByAmount('right')}
            size="icon"
            variant="ghost"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        ) : null}
        <WorkspaceAddTabMenu apps={apps} onOpenApp={onOpenApp} />
        {hasAnyTab ? (
          <TabStripOverflowMenu hasFileTabs={tabs.length > 0} onCloseAll={onCloseAllFileTabs} />
        ) : null}
      </div>
    </ActionContextMenu>
  );
}

interface TablistKeyHandlers {
  readonly onCloseApp: (appId: string) => void;
  readonly onCloseFileTab: (tabId: string) => void;
}

/** Index the roving-focus target for an arrow/Home/End key, or null to ignore. */
function resolveTablistTargetIndex(
  key: string,
  currentIndex: number,
  count: number
): number | null {
  switch (key) {
    case 'ArrowLeft':
      return currentIndex <= 0 ? count - 1 : currentIndex - 1;
    case 'ArrowRight':
      return currentIndex === -1 ? 0 : (currentIndex + 1) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * Roving tablist keyboard contract (APG **manual activation**): Arrow/Home/End
 * move FOCUS only — Enter/Space (the focused button's native activation)
 * selects. Manual activation is deliberate (review finding): selecting a
 * `needs-permission` file tab raises a real browser permission prompt, so
 * focus movement must never activate. Delete closes the focused tab — app or
 * file, resolved via data attributes — then restores focus to the tab that
 * takes the closed one's place (or the last tab) so keyboard navigation
 * survives the close (review finding: focus otherwise falls to `body`).
 */
function dispatchTablistKey(
  event: KeyboardEvent<HTMLDivElement>,
  container: HTMLDivElement | null,
  handlers: TablistKeyHandlers
): void {
  if (!container) {
    return;
  }
  const tabEls = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
  if (tabEls.length === 0) {
    return;
  }
  const currentIndex =
    document.activeElement instanceof HTMLElement ? tabEls.indexOf(document.activeElement) : -1;
  const targetIndex = resolveTablistTargetIndex(event.key, currentIndex, tabEls.length);
  if (targetIndex !== null) {
    event.preventDefault();
    tabEls[targetIndex]?.focus();
    return;
  }
  if (event.key !== 'Delete' || currentIndex === -1) {
    return;
  }
  event.preventDefault();
  const el = tabEls[currentIndex];
  const appId = el?.dataset['appId'];
  const tabId = el?.dataset['tabId'];
  if (appId) {
    handlers.onCloseApp(appId);
  } else if (tabId) {
    handlers.onCloseFileTab(tabId);
  }
  // Restore focus after React commits the close: the tab that slid into the
  // closed one's index, else the new last tab. requestAnimationFrame matches
  // the focus-restoration idiom used by the panel chrome (ide-layout).
  requestAnimationFrame(() => {
    const remaining = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
    const successor = remaining[currentIndex] ?? remaining.at(-1);
    successor?.focus();
  });
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  // Test environments may stub matchMedia to return undefined — treat any
  // non-conforming result as "no preference".
  return window.matchMedia('(prefers-reduced-motion: reduce)')?.matches === true;
}

interface TabStripOverflowMenuProps {
  readonly hasFileTabs: boolean;
  readonly onCloseAll: () => void;
}

/**
 * "More actions" affordance at the right edge of the tab strip. Currently just
 * hosts "Close All Tabs", but the structure is here so future bulk actions can
 * slot in without rewiring the strip.
 */
function TabStripOverflowMenu({ hasFileTabs, onCloseAll }: TabStripOverflowMenuProps) {
  return (
    <div className="flex flex-shrink-0 items-center px-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="More tab actions"
            className="h-7 w-7 rounded-sm"
            size="icon"
            title="More tab actions"
            variant="ghost"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="bottom" sideOffset={6}>
          <DropdownMenuItem disabled={!hasFileTabs} onSelect={onCloseAll}>
            Close All Tabs
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

interface AppTabButtonProps {
  readonly app: WorkspaceApp;
  readonly isActive: boolean;
  /** Handlers take the app id — stable parent refs keep the memo effective. */
  readonly onClose: (appId: string) => void;
  readonly onSelect: (appId: string) => void;
}

/**
 * A singleton app tab: icon-forward "pill" treatment, visually distinct from
 * file tabs (which keep the classic bottom-border indicator). Closable — the
 * close affordance shows on hover/focus and always on the active tab.
 */
const AppTabButton = memo<AppTabButtonProps>(function AppTabButton({
  app,
  isActive,
  onClose,
  onSelect,
}) {
  const Icon = app.icon;
  const handleSelect = useCallback(() => onSelect(app.id), [onSelect, app.id]);
  const handleClose = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      onClose(app.id);
    },
    [onClose, app.id]
  );
  return (
    <div
      className={cn(
        'group/app-tab my-1 flex flex-shrink-0 items-stretch overflow-hidden rounded-md transition-colors motion-reduce:transition-none',
        isActive
          ? app.tabAppearance
            ? `text-foreground ${app.tabAppearance.selectedClassName}`
            : 'bg-primary/10 text-primary'
          : app.tabAppearance
            ? `text-muted-foreground hover:text-foreground ${app.tabAppearance.idleClassName}`
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      )}
      data-agent-color={app.tabAppearance?.colorId}
      role="presentation"
      style={app.tabAppearance?.style}
    >
      <button
        aria-controls={`workspace-app-panel-${app.id}`}
        aria-selected={isActive}
        className="flex items-center gap-1.5 py-1 pr-1 pl-2.5 font-medium text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-app-id={app.id}
        data-testid={`workspace-app-tab-${app.id}`}
        id={`workspace-app-tab-${app.id}`}
        onClick={handleSelect}
        role="tab"
        tabIndex={isActive ? 0 : -1}
        type="button"
      >
        {app.tabAppearance ? (
          <span
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded border',
              app.tabAppearance.markClassName ?? app.tabAppearance.accentClassName
            )}
            data-testid="workspace-agent-mark"
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
        ) : (
          <Icon className="h-3.5 w-3.5" />
        )}
        <span>{app.label}</span>
      </button>
      <Button
        aria-label={`Close ${app.label}`}
        className={cn(
          'my-auto mr-1 h-5 w-5 flex-shrink-0 rounded-sm',
          isActive
            ? 'opacity-100'
            : 'opacity-0 focus-visible:opacity-100 group-hover/app-tab:opacity-100'
        )}
        data-testid={`workspace-app-tab-close-${app.id}`}
        onClick={handleClose}
        size="icon"
        tabIndex={-1}
        title={`Close ${app.label}`}
        variant="ghost"
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
});

interface FileTabButtonProps {
  readonly isActive: boolean;
  readonly isLoading: boolean;
  /**
   * Handlers receive the tab id as their argument. Wiring the dispatch *inside* the
   * child (not via an inline arrow in the parent's `.map`) keeps the props stable
   * across parent re-renders so the `React.memo` wrap stays effective.
   */
  readonly onClose: (tabId: string) => void;
  readonly onContextMenu: (tab: FileTab) => void;
  readonly onSelect: (tabId: string) => void | Promise<void>;
  readonly status: TabFileStatus | undefined;
  readonly statusMessage: string | null;
  readonly tab: FileTab;
}

/**
 * Memoized so an unrelated parent re-render (e.g. fileContents tick during a background
 * file load) doesn't reconcile every visible file tab.
 */
const FileTabButton = memo<FileTabButtonProps>(function FileTabButton({
  tab,
  isActive,
  isLoading,
  status,
  statusMessage,
  onSelect,
  onClose,
  onContextMenu,
}) {
  const fileName = getFileName(tab.path);
  const tabButtonId = `workspace-file-tab-${tab.id}`;
  const panelId = `workspace-file-panel-${tab.id}`;
  const isDeleted = status?.status === 'not-found';
  const handleSelect = useCallback(() => {
    void onSelect(tab.id);
  }, [onSelect, tab.id]);
  const handleClose = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      onClose(tab.id);
    },
    [onClose, tab.id]
  );
  const handleContextMenu = useCallback(() => {
    onContextMenu(tab);
  }, [onContextMenu, tab]);
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: composite tab wrapper claims context-menu identity for its focusable tab button
    // biome-ignore lint/a11y/noStaticElementInteractions: composite tab wrapper claims context-menu identity for its focusable tab button
    <div
      className={cn(
        'flex flex-shrink-0 items-center border-transparent border-b-2',
        isActive ? 'border-b-primary bg-background' : 'hover:bg-muted/60'
      )}
      onContextMenu={handleContextMenu}
      role="presentation"
    >
      <button
        aria-controls={panelId}
        aria-label={isDeleted ? `${fileName} (deleted)` : undefined}
        aria-selected={isActive}
        className={cn(
          'flex h-full items-center gap-2 px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          status?.status === 'needs-permission' && 'text-amber-600 dark:text-amber-400',
          isDeleted && 'text-destructive'
        )}
        data-state={status?.status}
        data-tab-id={tab.id}
        data-testid={tabButtonId}
        id={tabButtonId}
        onClick={handleSelect}
        role="tab"
        tabIndex={isActive ? 0 : -1}
        title={statusMessage ?? fileName}
        type="button"
      >
        <FileTabIcon isLoading={isLoading} status={status} />
        <span className={cn('max-w-[20ch] truncate', isDeleted && 'line-through')}>{fileName}</span>
      </button>
      <Button
        aria-label={`Close ${fileName}`}
        className="mr-1 h-6 w-6 flex-shrink-0 rounded-sm"
        onClick={handleClose}
        size="icon"
        tabIndex={-1}
        title={`Close ${fileName}`}
        variant="ghost"
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
});

interface FileTabIconProps {
  readonly isLoading: boolean;
  readonly status: TabFileStatus | undefined;
}

function FileTabIcon({ isLoading, status }: FileTabIconProps): ReactNode {
  if (isLoading) {
    return <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />;
  }
  if (status?.status === 'needs-permission') {
    return <LockKeyhole className="h-3 w-3 flex-shrink-0 text-amber-500" />;
  }
  if (status?.status === 'not-found') {
    return <AlertCircle className="h-3 w-3 flex-shrink-0 text-destructive" />;
  }
  return <File className="h-3 w-3 flex-shrink-0" />;
}
