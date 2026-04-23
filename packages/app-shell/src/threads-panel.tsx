import { usePGliteDatabase } from '@brainstrike/db';
import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui';
import { Button } from '@brainstrike/ui';
import { MessageSquare, Plus } from 'lucide-react';
import type { ReactElement } from 'react';
import { useEffect, useMemo } from 'react';
import {
  type AssistantMemoryThread,
  type AssistantThreadRepository,
  createPgliteAssistantThreadRepository,
} from './assistant-memory-repository';
import { useAssistantThreadStore } from './assistant-thread-store';

type ThreadPanelLoadState =
  | { readonly status: 'idle' | 'loading' | 'ready' }
  | { readonly error: string; readonly status: 'error' };

function ThreadStateCard({
  description,
  testId,
  title,
  variant = 'muted',
}: {
  readonly description: string;
  readonly testId: string;
  readonly title: string;
  readonly variant?: 'error' | 'muted';
}): ReactElement {
  const className =
    variant === 'error'
      ? 'rounded-xl border border-destructive/30 bg-destructive/5 p-4'
      : 'rounded-xl border border-border border-dashed bg-background/70 p-4';
  return (
    <div className={className} data-testid={testId}>
      <div className="font-medium text-sm">{title}</div>
      <p className="pt-2 text-muted-foreground text-xs leading-5">{description}</p>
    </div>
  );
}

function ThreadRows({
  onSelectThread,
  selectedThreadId,
  threads,
}: {
  readonly onSelectThread: (threadId: string) => void;
  readonly selectedThreadId: string | undefined;
  readonly threads: readonly AssistantMemoryThread[];
}): ReactElement {
  return (
    <div className="space-y-2">
      {threads.map((thread) => {
        const isSelected = selectedThreadId === thread.id;
        return (
          <button
            aria-current={isSelected ? 'true' : undefined}
            className={`w-full rounded-lg border px-3 py-2 text-left ${
              isSelected ? 'border-primary/50 bg-primary/5' : 'border-border bg-background'
            }`}
            data-testid="thread-row"
            key={thread.id}
            onClick={() => {
              onSelectThread(thread.id);
            }}
            type="button"
          >
            <div className="flex min-w-0 items-center gap-2 font-medium text-xs">
              <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{thread.title}</span>
            </div>
            <div className="truncate pt-1 text-[11px] text-muted-foreground">{thread.id}</div>
          </button>
        );
      })}
    </div>
  );
}

function ThreadsPanelContent({
  loadState,
  onSelectThread,
  repository,
  resourceId,
  selectedThreadId,
  threads,
}: {
  readonly loadState: ThreadPanelLoadState | null;
  readonly onSelectThread: (threadId: string) => void;
  readonly repository: AssistantThreadRepository | null;
  readonly resourceId: string | null;
  readonly selectedThreadId: string | undefined;
  readonly threads: readonly AssistantMemoryThread[];
}): ReactElement {
  if (!resourceId) {
    return (
      <ThreadStateCard
        description="Open a workspace to load its Mastra memory threads."
        testId="threads-placeholder-card"
        title="No workspace open"
      />
    );
  }
  if (!repository) {
    return (
      <ThreadStateCard
        description="The assistant is unavailable until PGlite memory initializes."
        testId="threads-error-card"
        title="Assistant memory database unavailable"
        variant="error"
      />
    );
  }
  if (loadState?.status === 'error') {
    return (
      <ThreadStateCard
        description={loadState.error}
        testId="threads-error-card"
        title="Failed to load threads"
        variant="error"
      />
    );
  }
  if (loadState?.status === 'loading' && threads.length === 0) {
    return (
      <ThreadStateCard
        description="Reading Mastra memory from PGlite."
        testId="threads-loading-card"
        title="Loading threads..."
      />
    );
  }
  if (threads.length === 0) {
    return (
      <ThreadStateCard
        description="Create a new Mastra memory thread for this workspace."
        testId="threads-placeholder-card"
        title="No threads found"
      />
    );
  }
  return (
    <ThreadRows
      onSelectThread={onSelectThread}
      selectedThreadId={selectedThreadId}
      threads={threads}
    />
  );
}

export function ThreadsPanel(): ReactElement {
  const database = usePGliteDatabase();
  const rootDirectoryHandle = useFileExplorerStoreSelector((state) => state.rootDirectoryHandle);
  const resourceId = rootDirectoryHandle?.path ?? null;
  const repository = useMemo(
    () => (database ? createPgliteAssistantThreadRepository(database) : null),
    [database]
  );
  const selectedThreadByResourceId = useAssistantThreadStore(
    (state) => state.selectedThreadByResourceId
  );
  const threadsByResourceId = useAssistantThreadStore((state) => state.threadsByResourceId);
  const loadStateByResourceId = useAssistantThreadStore((state) => state.loadStateByResourceId);
  const ensureResourceThreads = useAssistantThreadStore((state) => state.ensureResourceThreads);
  const createThread = useAssistantThreadStore((state) => state.createThread);
  const selectThread = useAssistantThreadStore((state) => state.selectThread);
  const selectedThreadId = resourceId ? selectedThreadByResourceId[resourceId] : undefined;
  const threads = resourceId ? (threadsByResourceId[resourceId] ?? []) : [];
  const loadState = resourceId ? (loadStateByResourceId[resourceId] ?? { status: 'idle' }) : null;
  const handleSelectThread = (threadId: string): void => {
    if (!resourceId) {
      return;
    }
    selectThread(resourceId, threadId);
  };

  useEffect(() => {
    if (!(repository && resourceId)) {
      return;
    }
    ensureResourceThreads(repository, resourceId).catch(() => {
      // The store records the explicit error state; no fallback thread source is used.
    });
  }, [ensureResourceThreads, repository, resourceId]);

  return (
    <section
      aria-label="Threads"
      className="flex min-h-0 flex-col border-border border-b bg-muted/20"
      data-testid="threads-panel"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <div>
          <div className="flex items-center gap-2">
            <div className="font-medium text-sm">Threads</div>
            <span
              className="rounded-full border border-border bg-background px-2 py-0.5 font-medium text-[10px] text-muted-foreground uppercase tracking-[0.18em]"
              data-testid="threads-preview-badge"
            >
              Memory
            </span>
          </div>
          <div className="text-muted-foreground text-xs">Workspace-scoped Mastra history</div>
        </div>
        <Button
          aria-label="New thread"
          className="h-8 gap-1.5 px-2.5"
          data-testid="new-agent-button"
          disabled={!(repository && resourceId) || loadState?.status === 'loading'}
          onClick={() => {
            if (!(repository && resourceId)) {
              return;
            }
            createThread(repository, resourceId).catch(() => {
              // The store records the explicit error state; no fallback thread source is used.
            });
          }}
          size="sm"
          title={
            repository && resourceId
              ? 'Create a new Mastra memory thread for this workspace.'
              : 'Open a workspace with an initialized database to create threads.'
          }
          type="button"
          variant="secondary"
        >
          <Plus className="h-3.5 w-3.5" />
          <span className="text-xs">New Thread</span>
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <ThreadsPanelContent
          loadState={loadState}
          onSelectThread={handleSelectThread}
          repository={repository}
          resourceId={resourceId}
          selectedThreadId={selectedThreadId}
          threads={threads}
        />
      </div>
    </section>
  );
}
