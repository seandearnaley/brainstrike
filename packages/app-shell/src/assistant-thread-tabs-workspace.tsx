import {
  useAssistantMemoryDbClient,
  useDbInitializationStatus,
  useDbInitializing,
  useDbProviderError,
} from '@brainstrike/db';
import { Button } from '@brainstrike/ui';
import { ChevronLeft, ChevronRight, MessageSquare, Plus, X } from 'lucide-react';
import type { ReactElement, WheelEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createAssistantThreadRepository } from './assistant-memory-repository';
import { WORKSPACE_MEMORY_RESOURCE_ID } from './assistant-memory-resource';
import { shouldRenderAssistantThreadDatabaseStartupLoading } from './assistant-thread-database-state';
import { useAssistantThreadStore } from './assistant-thread-store';
import type { AssistantUiPanelWrapperProps } from './assistant-ui-panel-wrapper';
import { AssistantUiPanelWrapper } from './assistant-ui-panel-wrapper';

interface TabScrollState {
  readonly canScrollBack: boolean;
  readonly canScrollForward: boolean;
}

const EMPTY_TAB_SCROLL_STATE: TabScrollState = {
  canScrollBack: false,
  canScrollForward: false,
};

export interface AssistantThreadTabsWorkspaceProps {
  readonly initialProviders?: AssistantUiPanelWrapperProps['initialProviders'];
  readonly loadLocalLlmBackend?: AssistantUiPanelWrapperProps['loadLocalLlmBackend'];
}

export function AssistantThreadTabsWorkspace({
  initialProviders,
  loadLocalLlmBackend,
}: AssistantThreadTabsWorkspaceProps): ReactElement {
  const database = useAssistantMemoryDbClient();
  const databaseInitializing = useDbInitializing();
  const databaseStatus = useDbInitializationStatus();
  const databaseError = useDbProviderError();
  // Workspace-global assistant memory: one stable resource id, never the focused
  // root path. See assistant-memory-resource.ts.
  const resourceId = WORKSPACE_MEMORY_RESOURCE_ID;
  const repository = useMemo(
    () => (database ? createAssistantThreadRepository(database.db, database.runtimeEngine) : null),
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
  const closeThreadTab = useAssistantThreadStore((state) => state.closeThreadTab);

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
  }, [updateTabScrollState]);

  const scrollTabList = useCallback(
    (direction: 'back' | 'forward'): void => {
      const scrollNode = tabScrollRef.current;
      if (!scrollNode) {
        return;
      }

      const distance = Math.max(160, scrollNode.clientWidth * 0.7);
      scrollNode.scrollBy({
        behavior: 'smooth',
        left: direction === 'back' ? -distance : distance,
      });
      window.requestAnimationFrame(updateTabScrollState);
    },
    [updateTabScrollState]
  );

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
    return (
      <ThreadWorkspaceState description="Loading assistant memory database." title="Loading" />
    );
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
        description="Assistant memory requires an initialized database."
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
    return (
      <ThreadWorkspaceState description="Loading assistant memory database." title="Loading" />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="assistant-thread-tabs-workspace">
      <div
        className="flex h-12 flex-shrink-0 items-start gap-1.5 border-border border-b bg-muted/20 px-2 pt-1.5"
        data-testid="assistant-thread-tab-strip"
      >
        <Button
          aria-label="Scroll assistant tabs left"
          className="h-8 w-8 shrink-0 rounded-full border border-border/70 bg-background/80 p-0 shadow-sm disabled:opacity-35"
          data-testid="assistant-tabs-scroll-left"
          disabled={!tabScrollState.canScrollBack}
          onClick={() => scrollTabList('back')}
          size="icon"
          type="button"
          variant="ghost"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <div
          aria-label="Open assistant threads"
          className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden pb-1 [scrollbar-gutter:stable]"
          data-testid="assistant-thread-tab-scroll"
          onScroll={updateTabScrollState}
          onWheel={handleTabWheel}
          ref={tabScrollRef}
          role="tablist"
        >
          <div className="flex min-w-max items-start gap-1">
            {openThreadIds.map((threadId) => {
              const thread = threadById.get(threadId);
              const title = thread?.title ?? threadId;
              const isActive = threadId === activeThreadId;
              return (
                <div
                  className={`group flex h-8 min-w-36 max-w-64 items-center rounded-t-lg border border-b-0 px-2.5 text-sm transition-colors ${
                    isActive
                      ? 'border-border bg-background text-foreground shadow-sm'
                      : 'border-transparent bg-muted/35 text-muted-foreground hover:border-border/70 hover:bg-background/60 hover:text-foreground'
                  }`}
                  key={threadId}
                >
                  <button
                    aria-selected={isActive}
                    className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => openThreadTab(resourceId, threadId)}
                    role="tab"
                    type="button"
                  >
                    <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{title}</span>
                  </button>
                  <button
                    aria-label={`Close thread ${title}`}
                    className="ml-2 rounded p-1 text-muted-foreground opacity-70 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
                    onClick={() => closeThreadTab(resourceId, threadId)}
                    type="button"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <Button
          aria-label="Scroll assistant tabs right"
          className="h-8 w-8 shrink-0 rounded-full border border-border/70 bg-background/80 p-0 shadow-sm disabled:opacity-35"
          data-testid="assistant-tabs-scroll-right"
          disabled={!tabScrollState.canScrollForward}
          onClick={() => scrollTabList('forward')}
          size="icon"
          type="button"
          variant="ghost"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        <div className="flex h-8 shrink-0 items-center">
          <Button
            aria-label="New assistant thread"
            className="h-8 gap-1.5 rounded-full border border-border/70 bg-background/85 px-2.5 shadow-sm"
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
            <span className="text-xs">New</span>
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
                className="h-full min-h-0"
                data-testid={`assistant-thread-panel-${threadId}`}
                hidden={!isActive}
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
