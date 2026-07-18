import {
  type AnyContextAction,
  defineContextAction,
  type TargetOf,
} from '@brainstrike/context-actions';
import {
  useDbInitializationStatus,
  useDbInitializing,
  useDbProviderError,
  usePGliteDatabase,
} from '@brainstrike/db';
import { ActionContextMenu, Button, useContextMenuTarget } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  Plus,
  X,
} from 'lucide-react';
import type { KeyboardEvent, ReactElement, WheelEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPgliteAssistantThreadRepository } from './assistant-memory-repository';
import { WORKSPACE_MEMORY_RESOURCE_ID } from './assistant-memory-resource';
import { AssistantPanelLoadingState } from './assistant-panel-loading-state';
import { assistantThreadToTarget } from './assistant-thread-context-actions';
import { shouldRenderAssistantThreadDatabaseStartupLoading } from './assistant-thread-database-state';
import { getAssistantThreadColorPresentation } from './assistant-thread-presentation';
import { useAssistantThreadStore } from './assistant-thread-store';
import {
  AssistantThreadTabDndShell,
  useAssistantThreadTabAutoScroll,
  useAssistantThreadTabDropMonitor,
} from './assistant-thread-tabs-dnd-elements';
import type { AssistantUiPanelWrapperProps } from './assistant-ui-panel-wrapper';
import { AssistantUiPanelWrapper } from './assistant-ui-panel-wrapper';

const logger = createLogger('AssistantThreadTabsWorkspace');

interface TabScrollState {
  readonly canScrollBack: boolean;
  readonly canScrollForward: boolean;
}

const EMPTY_TAB_SCROLL_STATE: TabScrollState = {
  canScrollBack: false,
  canScrollForward: false,
};

type TabReorderDirection = 'left' | 'right';

function readTabReorderDirection(
  event: KeyboardEvent<HTMLButtonElement>
): TabReorderDirection | null {
  if (!(event.altKey && event.shiftKey)) {
    return null;
  }
  if (event.key === 'ArrowLeft') {
    return 'left';
  }
  if (event.key === 'ArrowRight') {
    return 'right';
  }
  return null;
}

function reorderTabByOnePosition({
  currentIndex,
  currentOpenThreadIds,
  direction,
  threadId,
}: {
  readonly currentIndex: number;
  readonly currentOpenThreadIds: readonly string[];
  readonly direction: TabReorderDirection;
  readonly threadId: string;
}): readonly string[] | null {
  const destinationIndex = currentIndex + (direction === 'left' ? -1 : 1);
  const adjacentThreadId = currentOpenThreadIds[destinationIndex];
  if (!adjacentThreadId) {
    return null;
  }
  const orderedThreadIds = [...currentOpenThreadIds];
  orderedThreadIds[currentIndex] = adjacentThreadId;
  orderedThreadIds[destinationIndex] = threadId;
  return orderedThreadIds;
}

function resolveKeyboardNavigationTarget({
  currentIndex,
  currentOpenThreadIds,
  key,
}: {
  readonly currentIndex: number;
  readonly currentOpenThreadIds: readonly string[];
  readonly key: string;
}): string | undefined {
  if (key === 'ArrowLeft') {
    return currentOpenThreadIds.at(currentIndex - 1) ?? currentOpenThreadIds.at(-1);
  }
  if (key === 'ArrowRight') {
    return currentOpenThreadIds[currentIndex + 1] ?? currentOpenThreadIds.at(0);
  }
  if (key === 'Home') {
    return currentOpenThreadIds.at(0);
  }
  if (key === 'End') {
    return currentOpenThreadIds.at(-1);
  }
  return;
}

function getTabId(threadId: string): string {
  return `assistant-thread-tab-${threadId}`;
}

function getTabPanelId(threadId: string): string {
  return `assistant-thread-panel-${threadId}`;
}

function readReducedMotionPreference(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)')?.matches ?? false;
}

function useReducedMotionPreference(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(readReducedMotionPreference);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return;
    }
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!mediaQuery) {
      return;
    }
    const handleChange = (): void => setPrefersReducedMotion(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return prefersReducedMotion;
}

export interface AssistantThreadTabsWorkspaceProps {
  readonly initialProviders?: AssistantUiPanelWrapperProps['initialProviders'];
  readonly loadLocalLlmBackend?: AssistantUiPanelWrapperProps['loadLocalLlmBackend'];
}

export function AssistantThreadTabsWorkspace({
  initialProviders,
  loadLocalLlmBackend,
}: AssistantThreadTabsWorkspaceProps): ReactElement {
  const database = usePGliteDatabase();
  const databaseInitializing = useDbInitializing();
  const databaseStatus = useDbInitializationStatus();
  const databaseError = useDbProviderError();
  // Workspace-global assistant memory: one stable resource id, never the focused
  // root path. See assistant-memory-resource.ts.
  const resourceId = WORKSPACE_MEMORY_RESOURCE_ID;
  const repository = useMemo(
    () => (database ? createPgliteAssistantThreadRepository(database) : null),
    [database]
  );
  const databaseStartupLoading = shouldRenderAssistantThreadDatabaseStartupLoading({
    databaseError,
    databaseInitializing,
    databaseStatus,
    repositoryReady: Boolean(repository),
  });

  const activeThreadIdByResourceId = useAssistantThreadStore(
    (state) => state.activeThreadIdByResourceId
  );
  const openThreadIdsByResourceId = useAssistantThreadStore(
    (state) => state.openThreadIdsByResourceId
  );
  const threadsByResourceId = useAssistantThreadStore((state) => state.threadsByResourceId);
  const loadStateByResourceId = useAssistantThreadStore((state) => state.loadStateByResourceId);
  const ensureResourceThreads = useAssistantThreadStore((state) => state.ensureResourceThreads);
  const createThread = useAssistantThreadStore((state) => state.createThread);
  const openThreadTab = useAssistantThreadStore((state) => state.openThreadTab);
  const closeAllThreadTabs = useAssistantThreadStore((state) => state.closeAllThreadTabs);
  const closeOtherThreadTabs = useAssistantThreadStore((state) => state.closeOtherThreadTabs);
  const closeThreadTab = useAssistantThreadStore((state) => state.closeThreadTab);
  const closeThreadTabsToRight = useAssistantThreadStore((state) => state.closeThreadTabsToRight);
  const reorderThreadTabs = useAssistantThreadStore((state) => state.reorderThreadTabs);

  const loadState = loadStateByResourceId[resourceId] ?? { status: 'idle' };
  const threads = threadsByResourceId[resourceId] ?? [];
  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads]
  );
  const openThreadIds = openThreadIdsByResourceId[resourceId] ?? [];
  const activeThreadId = activeThreadIdByResourceId[resourceId];
  const tabScrollRef = useRef<HTMLDivElement | null>(null);
  const [tabScrollState, setTabScrollState] = useState<TabScrollState>(EMPTY_TAB_SCROLL_STATE);
  const prefersReducedMotion = useReducedMotionPreference();
  const contextMenuController = useContextMenuTarget();
  const { setTarget: setContextMenuTarget } = contextMenuController;

  const handleThreadTabContextMenu = useCallback(
    (threadId: string): void => {
      const thread = threadById.get(threadId);
      if (!thread) {
        logger.error('Could not resolve assistant thread tab context target', {
          resourceId,
          threadId,
        });
        setContextMenuTarget(null);
        return;
      }
      setContextMenuTarget(assistantThreadToTarget(thread, 'assistant-thread-tab'));
    },
    [resourceId, setContextMenuTarget, threadById]
  );

  const focusThreadTab = useCallback((threadId: string): void => {
    document.getElementById(getTabId(threadId))?.focus();
  }, []);

  const focusThreadTargetOnNextFrame = useCallback(
    (threadId: string | undefined): void => {
      window.requestAnimationFrame(() => {
        if (threadId) {
          focusThreadTab(threadId);
          return;
        }
        document
          .querySelector<HTMLButtonElement>('[data-testid="assistant-new-thread-button"]')
          ?.focus();
      });
    },
    [focusThreadTab]
  );

  const handleCloseThreadTab = useCallback(
    (threadId: string): void => {
      const currentOpenThreadIds =
        useAssistantThreadStore.getState().openThreadIdsByResourceId[resourceId] ?? [];
      const closingIndex = currentOpenThreadIds.indexOf(threadId);
      if (closingIndex === -1) {
        return;
      }
      const currentActiveThreadId =
        useAssistantThreadStore.getState().activeThreadIdByResourceId[resourceId];
      const nextFocusThreadId =
        currentActiveThreadId === threadId
          ? (currentOpenThreadIds[closingIndex + 1] ?? currentOpenThreadIds[closingIndex - 1])
          : currentActiveThreadId;
      closeThreadTab(resourceId, threadId);
      focusThreadTargetOnNextFrame(nextFocusThreadId);
    },
    [closeThreadTab, focusThreadTargetOnNextFrame, resourceId]
  );

  const handleReorderThreadTabs = useCallback(
    (orderedThreadIds: readonly string[]): void => {
      reorderThreadTabs(resourceId, orderedThreadIds);
    },
    [reorderThreadTabs, resourceId]
  );

  const handleTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, threadId: string): void => {
      const currentOpenThreadIds =
        useAssistantThreadStore.getState().openThreadIdsByResourceId[resourceId] ?? [];
      const currentIndex = currentOpenThreadIds.indexOf(threadId);
      if (currentIndex === -1) {
        return;
      }
      if (event.key === 'Delete') {
        event.preventDefault();
        handleCloseThreadTab(threadId);
        return;
      }

      const reorderDirection = readTabReorderDirection(event);
      if (reorderDirection) {
        event.preventDefault();
        const orderedThreadIds = reorderTabByOnePosition({
          currentIndex,
          currentOpenThreadIds,
          direction: reorderDirection,
          threadId,
        });
        if (!orderedThreadIds) {
          return;
        }
        reorderThreadTabs(resourceId, orderedThreadIds);
        focusThreadTargetOnNextFrame(threadId);
        return;
      }

      const nextThreadId = resolveKeyboardNavigationTarget({
        currentIndex,
        currentOpenThreadIds,
        key: event.key,
      });
      if (!nextThreadId) {
        return;
      }
      event.preventDefault();
      openThreadTab(resourceId, nextThreadId);
      focusThreadTab(nextThreadId);
    },
    [
      focusThreadTab,
      focusThreadTargetOnNextFrame,
      handleCloseThreadTab,
      openThreadTab,
      reorderThreadTabs,
      resourceId,
    ]
  );

  const threadTabActions = useMemo<readonly AnyContextAction[]>(() => {
    function isOpen(target: TargetOf<'assistant-thread-tab'>): boolean {
      return (
        useAssistantThreadStore
          .getState()
          .openThreadIdsByResourceId[target.resourceId]?.includes(target.id) ?? false
      );
    }

    return [
      defineContextAction({
        appliesTo: ['assistant-thread-tab'] as const,
        group: 'primary',
        icon: X,
        id: 'assistant-thread-tab.close',
        isEnabled: (target) => isOpen(target),
        label: 'Close',
        run: (target) => {
          if (!isOpen(target)) {
            return Promise.resolve({ error: 'Thread tab is no longer open', ok: false });
          }
          handleCloseThreadTab(target.id);
          return Promise.resolve({ ok: true });
        },
      }),
      defineContextAction({
        appliesTo: ['assistant-thread-tab'] as const,
        group: 'primary',
        id: 'assistant-thread-tab.close-others',
        isEnabled: (target) =>
          isOpen(target) && (openThreadIdsByResourceId[target.resourceId]?.length ?? 0) > 1,
        label: 'Close Others',
        run: (target) => {
          if (!isOpen(target)) {
            return Promise.resolve({ error: 'Thread tab is no longer open', ok: false });
          }
          closeOtherThreadTabs(target.resourceId, target.id);
          focusThreadTargetOnNextFrame(target.id);
          return Promise.resolve({ ok: true });
        },
      }),
      defineContextAction({
        appliesTo: ['assistant-thread-tab'] as const,
        group: 'primary',
        icon: ArrowLeft,
        id: 'assistant-thread-tab.move-left',
        isEnabled: (target) => {
          const currentOpenThreadIds =
            useAssistantThreadStore.getState().openThreadIdsByResourceId[target.resourceId] ?? [];
          return currentOpenThreadIds.indexOf(target.id) > 0;
        },
        label: 'Move Left',
        run: (target) => {
          const currentOpenThreadIds =
            useAssistantThreadStore.getState().openThreadIdsByResourceId[target.resourceId] ?? [];
          const currentIndex = currentOpenThreadIds.indexOf(target.id);
          if (currentIndex <= 0) {
            return Promise.resolve({ error: 'Thread tab cannot move left', ok: false });
          }
          const orderedThreadIds = [...currentOpenThreadIds];
          const adjacentThreadId = orderedThreadIds[currentIndex - 1];
          if (adjacentThreadId === undefined) {
            return Promise.resolve({ error: 'Adjacent thread tab is unavailable', ok: false });
          }
          orderedThreadIds[currentIndex - 1] = target.id;
          orderedThreadIds[currentIndex] = adjacentThreadId;
          reorderThreadTabs(target.resourceId, orderedThreadIds);
          focusThreadTargetOnNextFrame(target.id);
          return Promise.resolve({ message: `Moved ${target.title} left`, ok: true });
        },
      }),
      defineContextAction({
        appliesTo: ['assistant-thread-tab'] as const,
        group: 'primary',
        icon: ArrowRight,
        id: 'assistant-thread-tab.move-right',
        isEnabled: (target) => {
          const currentOpenThreadIds =
            useAssistantThreadStore.getState().openThreadIdsByResourceId[target.resourceId] ?? [];
          const currentIndex = currentOpenThreadIds.indexOf(target.id);
          return currentIndex >= 0 && currentIndex < currentOpenThreadIds.length - 1;
        },
        label: 'Move Right',
        run: (target) => {
          const currentOpenThreadIds =
            useAssistantThreadStore.getState().openThreadIdsByResourceId[target.resourceId] ?? [];
          const currentIndex = currentOpenThreadIds.indexOf(target.id);
          if (currentIndex === -1 || currentIndex >= currentOpenThreadIds.length - 1) {
            return Promise.resolve({ error: 'Thread tab cannot move right', ok: false });
          }
          const orderedThreadIds = [...currentOpenThreadIds];
          const adjacentThreadId = orderedThreadIds[currentIndex + 1];
          if (adjacentThreadId === undefined) {
            return Promise.resolve({ error: 'Adjacent thread tab is unavailable', ok: false });
          }
          orderedThreadIds[currentIndex] = adjacentThreadId;
          orderedThreadIds[currentIndex + 1] = target.id;
          reorderThreadTabs(target.resourceId, orderedThreadIds);
          focusThreadTargetOnNextFrame(target.id);
          return Promise.resolve({ message: `Moved ${target.title} right`, ok: true });
        },
      }),
      defineContextAction({
        appliesTo: ['assistant-thread-tab'] as const,
        group: 'primary',
        id: 'assistant-thread-tab.close-right',
        isEnabled: (target) => {
          const currentOpenThreadIds = openThreadIdsByResourceId[target.resourceId] ?? [];
          const targetIndex = currentOpenThreadIds.indexOf(target.id);
          return targetIndex >= 0 && targetIndex < currentOpenThreadIds.length - 1;
        },
        label: 'Close Tabs to the Right',
        run: (target) => {
          if (!isOpen(target)) {
            return Promise.resolve({ error: 'Thread tab is no longer open', ok: false });
          }
          closeThreadTabsToRight(target.resourceId, target.id);
          return Promise.resolve({ ok: true });
        },
      }),
      defineContextAction({
        appliesTo: ['assistant-thread-tab'] as const,
        group: 'primary',
        id: 'assistant-thread-tab.close-all',
        isEnabled: (target) => isOpen(target),
        label: 'Close All Tabs',
        run: (target) => {
          if (!isOpen(target)) {
            return Promise.resolve({ error: 'Thread tab is no longer open', ok: false });
          }
          closeAllThreadTabs(target.resourceId);
          focusThreadTargetOnNextFrame(undefined);
          return Promise.resolve({ ok: true });
        },
      }),
    ];
  }, [
    closeAllThreadTabs,
    closeOtherThreadTabs,
    closeThreadTabsToRight,
    focusThreadTargetOnNextFrame,
    handleCloseThreadTab,
    openThreadIdsByResourceId,
    reorderThreadTabs,
  ]);

  useAssistantThreadTabAutoScroll(tabScrollRef, openThreadIds.length);
  useAssistantThreadTabDropMonitor({
    onReorder: handleReorderThreadTabs,
    openThreadIds,
  });

  const updateTabScrollState = useCallback((): void => {
    const scrollNode = tabScrollRef.current;
    if (!scrollNode) {
      setTabScrollState(EMPTY_TAB_SCROLL_STATE);
      return;
    }

    const maxScrollLeft = Math.max(0, scrollNode.scrollWidth - scrollNode.clientWidth);
    const nextState: TabScrollState = {
      canScrollBack: scrollNode.scrollLeft > 1,
      canScrollForward: scrollNode.scrollLeft < maxScrollLeft - 1,
    };

    setTabScrollState((currentState) =>
      currentState.canScrollBack === nextState.canScrollBack &&
      currentState.canScrollForward === nextState.canScrollForward
        ? currentState
        : nextState
    );
  }, []);

  useEffect(() => {
    updateTabScrollState();
  }, [openThreadIds.length, updateTabScrollState]);

  useEffect(() => {
    const scrollNode = tabScrollRef.current;
    if (!(scrollNode && typeof ResizeObserver !== 'undefined')) {
      return;
    }

    const observer = new ResizeObserver(() => updateTabScrollState());
    observer.observe(scrollNode);
    if (scrollNode.firstElementChild) {
      observer.observe(scrollNode.firstElementChild);
    }

    return () => {
      observer.disconnect();
    };
  }, [openThreadIds.length, updateTabScrollState]);

  const scrollTabList = useCallback(
    (direction: 'back' | 'forward'): void => {
      const scrollNode = tabScrollRef.current;
      if (!scrollNode) {
        return;
      }

      const distance = Math.max(160, scrollNode.clientWidth * 0.7);
      scrollNode.scrollBy({
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
        left: direction === 'back' ? -distance : distance,
      });
      window.requestAnimationFrame(updateTabScrollState);
    },
    [prefersReducedMotion, updateTabScrollState]
  );

  useEffect(() => {
    if (!activeThreadId) {
      return;
    }
    // Scroll the whole tab shell (icon + title + in-flow close button) into
    // view, not just the tab button, so the close affordance is never clipped.
    const activeTabButton = document.getElementById(getTabId(activeThreadId));
    const activeTab = activeTabButton?.parentElement ?? activeTabButton;
    if (!activeTab || typeof activeTab.scrollIntoView !== 'function') {
      return;
    }
    activeTab.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
    window.requestAnimationFrame(updateTabScrollState);
  }, [activeThreadId, prefersReducedMotion, updateTabScrollState]);

  const handleTabWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>): void => {
      const scrollNode = event.currentTarget;
      if (scrollNode.scrollWidth <= scrollNode.clientWidth) {
        return;
      }

      const horizontalDelta =
        Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (horizontalDelta === 0) {
        return;
      }

      const maxScrollLeft = Math.max(0, scrollNode.scrollWidth - scrollNode.clientWidth);
      const nextScrollLeft = Math.min(
        maxScrollLeft,
        Math.max(0, scrollNode.scrollLeft + horizontalDelta)
      );
      if (nextScrollLeft === scrollNode.scrollLeft) {
        return;
      }

      event.preventDefault();
      scrollNode.scrollLeft = nextScrollLeft;
      updateTabScrollState();
    },
    [updateTabScrollState]
  );

  useEffect(() => {
    if (!repository) {
      return;
    }
    ensureResourceThreads(repository, resourceId).catch(() => {
      // The store records the explicit error state; the assistant remains unavailable.
    });
  }, [ensureResourceThreads, repository, resourceId]);

  if (!repository && databaseStartupLoading) {
    return <AssistantPanelLoadingState label="Loading PGlite-backed threads." />;
  }

  if (!repository && databaseError) {
    return (
      <ThreadWorkspaceState
        description={databaseError.message}
        title="Memory database failed"
        variant="error"
      />
    );
  }

  if (!repository) {
    return (
      <ThreadWorkspaceState
        description="Assistant memory requires an initialized PGlite database."
        title="Memory database unavailable"
        variant="error"
      />
    );
  }

  if (loadState?.status === 'error') {
    return (
      <ThreadWorkspaceState
        description={loadState.error}
        title="Assistant threads failed to load"
        variant="error"
      />
    );
  }

  if (loadState?.status === 'loading' && openThreadIds.length === 0) {
    return <AssistantPanelLoadingState label="Loading PGlite-backed threads." />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="assistant-thread-tabs-workspace">
      <div
        className="@container/assistant-tabs flex h-9 flex-shrink-0 items-center gap-1 border-border border-b bg-muted/20 px-2"
        data-testid="assistant-thread-tab-strip"
      >
        <Button
          aria-label="Scroll assistant tabs left"
          className="@[300px]/assistant-tabs:inline-flex hidden h-7 w-7 shrink-0 rounded-md border border-transparent p-0 text-muted-foreground shadow-none hover:border-border/70 hover:bg-background/80 hover:text-foreground disabled:opacity-30 motion-reduce:transition-none"
          data-testid="assistant-tabs-scroll-left"
          disabled={!tabScrollState.canScrollBack}
          onClick={() => scrollTabList('back')}
          size="icon"
          type="button"
          variant="ghost"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <ActionContextMenu controller={contextMenuController} localActions={threadTabActions}>
          <div
            aria-label="Open assistant threads"
            aria-orientation="horizontal"
            className="flex h-full min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            data-testid="assistant-thread-tab-scroll"
            onContextMenuCapture={() => setContextMenuTarget(null)}
            onScroll={updateTabScrollState}
            onWheel={handleTabWheel}
            ref={tabScrollRef}
            role="tablist"
          >
            <div className="flex w-max min-w-full items-center gap-1">
              {openThreadIds.map((threadId) => {
                const thread = threadById.get(threadId);
                const title = thread?.title ?? threadId;
                const isActive = threadId === activeThreadId;
                const colorId = thread?.metadata?.color;
                const colorPresentation = getAssistantThreadColorPresentation(colorId);
                return (
                  <AssistantThreadTabDndShell key={threadId} threadId={threadId}>
                    {(dragHandleRef) => (
                      // biome-ignore lint/a11y/noStaticElementInteractions: composite tab shell claims context-menu identity for its focusable controls
                      <div
                        className={`group flex h-7 min-w-0 items-center overflow-hidden rounded-md border pr-1.5 text-xs transition-[color,background-color,border-color,box-shadow,opacity] duration-150 motion-reduce:transition-none ${
                          isActive
                            ? 'border-border/90 bg-background text-foreground shadow-xs'
                            : 'border-transparent text-muted-foreground hover:bg-background/70 hover:text-foreground'
                        }`}
                        data-thread-color={colorId ?? 'unassigned'}
                        onContextMenu={() => handleThreadTabContextMenu(threadId)}
                        role="presentation"
                      >
                        <button
                          aria-controls={getTabPanelId(threadId)}
                          aria-haspopup="menu"
                          aria-selected={isActive}
                          className="flex h-full min-w-0 flex-1 cursor-grab items-center gap-2 py-0 pl-2 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:cursor-grabbing motion-reduce:transition-none"
                          id={getTabId(threadId)}
                          onClick={() => openThreadTab(resourceId, threadId)}
                          onKeyDown={(event) => handleTabKeyDown(event, threadId)}
                          ref={dragHandleRef}
                          role="tab"
                          tabIndex={isActive ? 0 : -1}
                          title={title}
                          type="button"
                        >
                          <span
                            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-sm ring-1 ring-inset ${
                              colorPresentation?.iconClassName ??
                              'bg-muted/70 text-muted-foreground ring-border/70'
                            }`}
                            data-testid={`assistant-thread-tab-icon-${colorId ?? 'unassigned'}`}
                          >
                            <MessageSquare className="h-3 w-3" />
                          </span>
                          <span className={`min-w-0 truncate ${isActive ? 'font-medium' : ''}`}>
                            {title}
                          </span>
                        </button>
                        <button
                          aria-label={`Close thread ${title}`}
                          className={`relative ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-[color,background-color,opacity] duration-150 after:absolute after:-inset-1 after:content-[''] hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${
                            isActive
                              ? 'opacity-70 hover:opacity-100'
                              : 'pointer-events-none opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100'
                          }`}
                          onClick={() => handleCloseThreadTab(threadId)}
                          tabIndex={-1}
                          type="button"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </AssistantThreadTabDndShell>
                );
              })}
            </div>
          </div>
        </ActionContextMenu>
        <Button
          aria-label="Scroll assistant tabs right"
          className="@[300px]/assistant-tabs:inline-flex hidden h-7 w-7 shrink-0 rounded-md border border-transparent p-0 text-muted-foreground shadow-none hover:border-border/70 hover:bg-background/80 hover:text-foreground disabled:opacity-30 motion-reduce:transition-none"
          data-testid="assistant-tabs-scroll-right"
          disabled={!tabScrollState.canScrollForward}
          onClick={() => scrollTabList('forward')}
          size="icon"
          type="button"
          variant="ghost"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        <div className="flex h-7 shrink-0 items-center border-border/70 border-l pl-1">
          <Button
            aria-label="New assistant thread"
            className="h-7 gap-1.5 rounded-md border border-transparent bg-transparent px-2 text-muted-foreground shadow-none hover:border-border/70 hover:bg-background/80 hover:text-foreground motion-reduce:transition-none"
            data-testid="assistant-new-thread-button"
            disabled={loadState?.status === 'loading'}
            onClick={() => {
              createThread(repository, resourceId).catch(() => {
                // The store records the explicit error state; no fallback thread source is used.
              });
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Plus className="h-3.5 w-3.5" />
            <span
              className="@[380px]/assistant-tabs:inline hidden text-xs"
              data-testid="assistant-new-thread-label"
            >
              New
            </span>
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {openThreadIds.length === 0 ? (
          <ThreadWorkspaceState
            description="Create or select a thread to mount an assistant session."
            title="No open assistant thread"
          />
        ) : (
          openThreadIds.map((threadId) => {
            const isActive = threadId === activeThreadId;
            return (
              <div
                aria-labelledby={getTabId(threadId)}
                className="h-full min-h-0"
                data-testid={`assistant-thread-panel-${threadId}`}
                hidden={!isActive}
                id={getTabPanelId(threadId)}
                key={threadId}
                role="tabpanel"
              >
                <AssistantUiPanelWrapper
                  {...(initialProviders ? { initialProviders } : {})}
                  {...(loadLocalLlmBackend ? { loadLocalLlmBackend } : {})}
                  memoryResourceId={resourceId}
                  memoryThreadId={threadId}
                />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function ThreadWorkspaceState({
  description,
  title,
  variant = 'muted',
}: {
  readonly description: string;
  readonly title: string;
  readonly variant?: 'error' | 'muted';
}): ReactElement {
  const tone = variant === 'error' ? 'text-destructive' : 'text-muted-foreground';
  return (
    <div
      className={`p-4 text-xs ${tone}`}
      data-testid="assistant-thread-workspace-state"
      data-variant={variant}
    >
      <div className="font-medium text-sm">{title}</div>
      <div className="mt-1">{description}</div>
    </div>
  );
}
