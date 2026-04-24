import { usePGliteDatabase } from '@brainstrike/db';
import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui';
import { Button } from '@brainstrike/ui';
import { MessageSquare, Plus, X } from 'lucide-react';
import type { ReactElement } from 'react';
import { useEffect, useMemo } from 'react';
import { createPgliteAssistantThreadRepository } from './assistant-memory-repository';
import { useAssistantThreadStore } from './assistant-thread-store';
import type { AssistantUiPanelWrapperProps } from './assistant-ui-panel-wrapper';
import { AssistantUiPanelWrapper } from './assistant-ui-panel-wrapper';

export interface AssistantThreadTabsWorkspaceProps {
  readonly initialProviders?: AssistantUiPanelWrapperProps['initialProviders'];
}

export function AssistantThreadTabsWorkspace({
  initialProviders,
}: AssistantThreadTabsWorkspaceProps): ReactElement {
  const database = usePGliteDatabase();
  const rootDirectoryHandle = useFileExplorerStoreSelector((state) => state.rootDirectoryHandle);
  const resourceId = rootDirectoryHandle?.path ?? null;
  const repository = useMemo(
    () => (database ? createPgliteAssistantThreadRepository(database) : null),
    [database]
  );

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

  const loadState = resourceId ? (loadStateByResourceId[resourceId] ?? { status: 'idle' }) : null;
  const threads = resourceId ? (threadsByResourceId[resourceId] ?? []) : [];
  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads]
  );
  const openThreadIds = resourceId ? (openThreadIdsByResourceId[resourceId] ?? []) : [];
  const activeThreadId = resourceId ? activeThreadIdByResourceId[resourceId] : undefined;

  useEffect(() => {
    if (!(repository && resourceId)) {
      return;
    }
    ensureResourceThreads(repository, resourceId).catch(() => {
      // The store records the explicit error state; the assistant remains unavailable.
    });
  }, [ensureResourceThreads, repository, resourceId]);

  if (!resourceId) {
    return (
      <ThreadWorkspaceState
        description="Open a workspace before starting assistant threads."
        title="No workspace open"
      />
    );
  }

  if (!repository) {
    return (
      <ThreadWorkspaceState
        description="Assistant memory requires an initialized PGlite database."
        title="Memory database unavailable"
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
    return <ThreadWorkspaceState description="Loading PGlite-backed threads." title="Loading" />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="assistant-thread-tabs-workspace">
      <div
        aria-label="Open assistant threads"
        className="flex h-11 flex-shrink-0 items-stretch gap-1 overflow-x-auto border-border border-b bg-muted/20 px-2 pt-1"
        role="tablist"
      >
        {openThreadIds.map((threadId) => {
          const thread = threadById.get(threadId);
          const title = thread?.title ?? threadId;
          const isActive = threadId === activeThreadId;
          return (
            <div
              className={`group flex min-w-36 max-w-64 items-center rounded-t-md border border-b-0 px-2.5 text-sm transition-colors ${
                isActive
                  ? 'border-border bg-background text-foreground shadow-sm'
                  : 'border-transparent bg-muted/35 text-muted-foreground hover:border-border/70 hover:bg-background/60 hover:text-foreground'
              }`}
              key={threadId}
            >
              <button
                aria-selected={isActive}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
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
        <Button
          aria-label="New assistant thread"
          className="my-1 h-8 gap-1.5 rounded-full border border-border/70 bg-background/70 px-2.5 shadow-sm"
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
    <div className={`p-4 text-xs ${tone}`} data-testid="assistant-thread-workspace-state">
      <div className="font-medium text-sm">{title}</div>
      <div className="mt-1">{description}</div>
    </div>
  );
}
