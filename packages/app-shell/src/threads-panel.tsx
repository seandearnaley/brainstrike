import { useDbInitializing, useDbProviderError, usePGliteDatabase } from '@brainstrike/db';
import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui/shell';
import { Button } from '@brainstrike/ui';
import { Check, MessageSquare, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  type AssistantMemoryThread,
  type AssistantThreadRepository,
  createPgliteAssistantThreadRepository,
} from './assistant-memory-repository';
import { useAssistantThreadStore } from './assistant-thread-store';

type ThreadPanelLoadState =
  | { readonly status: 'idle' | 'loading' | 'ready' }
  | { readonly error: string; readonly status: 'error' };

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  google: 'Google',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
};

function getProviderLabel(provider: string | undefined): string | null {
  if (!provider) {
    return null;
  }
  return PROVIDER_LABELS[provider] ?? provider;
}

function getReasoningLabel(thread: AssistantMemoryThread): string | null {
  const provider = thread.latestRun?.provider;
  const providerOptions = thread.latestRun?.providerOptions;
  const providerRecord =
    provider && providerOptions && typeof providerOptions[provider] === 'object'
      ? (providerOptions[provider] as Record<string, unknown>)
      : null;
  const reasoning = providerRecord?.['reasoningEffort'] ?? providerRecord?.['effort'];
  return typeof reasoning === 'string' && reasoning.trim() ? `Reasoning: ${reasoning}` : null;
}

function getMaxOutputLabel(thread: AssistantMemoryThread): string | null {
  const value = thread.latestRun?.modelSettings?.['maxOutputTokens'];
  return typeof value === 'number' && Number.isFinite(value) ? `Max output: ${value}` : null;
}

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
  onDeleteThread,
  onRenameThread,
  onSelectThread,
  selectedThreadId,
  threads,
}: {
  readonly onDeleteThread: (threadId: string) => Promise<void>;
  readonly onRenameThread: (threadId: string, title: string) => Promise<void>;
  readonly onSelectThread: (threadId: string) => void;
  readonly selectedThreadId: string | undefined;
  readonly threads: readonly AssistantMemoryThread[];
}): ReactElement {
  const [confirmingDeleteThreadId, setConfirmingDeleteThreadId] = useState<string | null>(null);
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState<string>('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [savingThreadId, setSavingThreadId] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      {threads.map((thread) => (
        <ThreadRowItem
          confirmingDeleteThreadId={confirmingDeleteThreadId}
          deleteError={deleteError}
          deletingThreadId={deletingThreadId}
          draftTitle={draftTitle}
          editingThreadId={editingThreadId}
          key={thread.id}
          onCancelRename={() => {
            setEditingThreadId(null);
            setDraftTitle('');
            setRenameError(null);
          }}
          onConfirmDeleteThread={() => {
            setDeletingThreadId(thread.id);
            setDeleteError(null);
            onDeleteThread(thread.id)
              .then(() => {
                setConfirmingDeleteThreadId(null);
              })
              .catch((error: unknown) => {
                setDeleteError(error instanceof Error ? error.message : String(error));
              })
              .finally(() => {
                setDeletingThreadId(null);
              });
          }}
          onDeleteThreadCancel={() => {
            setConfirmingDeleteThreadId(null);
            setDeleteError(null);
          }}
          onDeleteThreadStart={() => {
            setConfirmingDeleteThreadId(thread.id);
            setDeleteError(null);
          }}
          onDraftTitleChange={setDraftTitle}
          onRenameThread={onRenameThread}
          onRenameThreadStart={() => {
            setEditingThreadId(thread.id);
            setDraftTitle(thread.title);
            setRenameError(null);
          }}
          onRenameThreadSubmitError={setRenameError}
          onRenameThreadSubmitted={() => {
            setEditingThreadId(null);
            setDraftTitle('');
          }}
          onSavingThreadIdChange={setSavingThreadId}
          onSelectThread={onSelectThread}
          renameError={renameError}
          savingThreadId={savingThreadId}
          selectedThreadId={selectedThreadId}
          thread={thread}
        />
      ))}
    </div>
  );
}

function ThreadRowItem({
  confirmingDeleteThreadId,
  deletingThreadId,
  deleteError,
  draftTitle,
  editingThreadId,
  onCancelRename,
  onConfirmDeleteThread,
  onDeleteThreadCancel,
  onDeleteThreadStart,
  onDraftTitleChange,
  onRenameThread,
  onRenameThreadStart,
  onRenameThreadSubmitted,
  onRenameThreadSubmitError,
  onSavingThreadIdChange,
  onSelectThread,
  renameError,
  savingThreadId,
  selectedThreadId,
  thread,
}: {
  readonly confirmingDeleteThreadId: string | null;
  readonly deletingThreadId: string | null;
  readonly deleteError: string | null;
  readonly draftTitle: string;
  readonly editingThreadId: string | null;
  readonly onCancelRename: () => void;
  readonly onConfirmDeleteThread: () => void;
  readonly onDeleteThreadCancel: () => void;
  readonly onDeleteThreadStart: () => void;
  readonly onDraftTitleChange: (title: string) => void;
  readonly onRenameThread: (threadId: string, title: string) => Promise<void>;
  readonly onRenameThreadStart: () => void;
  readonly onRenameThreadSubmitted: () => void;
  readonly onRenameThreadSubmitError: (message: string) => void;
  readonly onSavingThreadIdChange: (threadId: string | null) => void;
  readonly onSelectThread: (threadId: string) => void;
  readonly renameError: string | null;
  readonly savingThreadId: string | null;
  readonly selectedThreadId: string | undefined;
  readonly thread: AssistantMemoryThread;
}): ReactElement {
  const isSelected = selectedThreadId === thread.id;
  const isEditing = editingThreadId === thread.id;
  const isConfirmingDelete = confirmingDeleteThreadId === thread.id;
  return (
    <div
      className={`w-full rounded-lg border px-3 py-2 text-left ${
        isSelected ? 'border-primary/50 bg-primary/5' : 'border-border bg-background'
      }`}
      data-testid="thread-row"
    >
      {isEditing ? (
        <ThreadRenameForm
          draftTitle={draftTitle}
          onCancelRename={onCancelRename}
          onDraftTitleChange={onDraftTitleChange}
          onRenameThread={onRenameThread}
          onRenameThreadSubmitError={onRenameThreadSubmitError}
          onRenameThreadSubmitted={onRenameThreadSubmitted}
          onSavingThreadIdChange={onSavingThreadIdChange}
          renameError={renameError}
          savingThreadId={savingThreadId}
          thread={thread}
        />
      ) : (
        <ThreadRowDisplay
          deleteError={isConfirmingDelete ? deleteError : null}
          deleting={deletingThreadId === thread.id}
          onConfirmDeleteThread={onConfirmDeleteThread}
          onDeleteThreadCancel={onDeleteThreadCancel}
          onDeleteThreadStart={onDeleteThreadStart}
          onRenameThreadStart={onRenameThreadStart}
          onSelectThread={onSelectThread}
          pendingDelete={isConfirmingDelete}
          selected={isSelected}
          thread={thread}
        />
      )}
    </div>
  );
}

function ThreadRenameForm({
  draftTitle,
  onCancelRename,
  onDraftTitleChange,
  onRenameThread,
  onRenameThreadSubmitted,
  onRenameThreadSubmitError,
  onSavingThreadIdChange,
  renameError,
  savingThreadId,
  thread,
}: {
  readonly draftTitle: string;
  readonly onCancelRename: () => void;
  readonly onDraftTitleChange: (title: string) => void;
  readonly onRenameThread: (threadId: string, title: string) => Promise<void>;
  readonly onRenameThreadSubmitted: () => void;
  readonly onRenameThreadSubmitError: (message: string) => void;
  readonly onSavingThreadIdChange: (threadId: string | null) => void;
  readonly renameError: string | null;
  readonly savingThreadId: string | null;
  readonly thread: AssistantMemoryThread;
}): ReactElement {
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSavingThreadIdChange(thread.id);
        onRenameThread(thread.id, draftTitle)
          .then(onRenameThreadSubmitted)
          .catch((error: unknown) => {
            onRenameThreadSubmitError(error instanceof Error ? error.message : String(error));
          })
          .finally(() => {
            onSavingThreadIdChange(null);
          });
      }}
    >
      <input
        aria-label="Thread title"
        className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => {
          onDraftTitleChange(event.target.value);
        }}
        value={draftTitle}
      />
      {renameError ? <span className="text-[11px] text-destructive">{renameError}</span> : null}
      <Button
        aria-label="Save thread title"
        disabled={savingThreadId === thread.id}
        size="icon"
        type="submit"
        variant="ghost"
      >
        <Check className="h-3.5 w-3.5" />
      </Button>
      <Button
        aria-label="Cancel rename"
        onClick={onCancelRename}
        size="icon"
        type="button"
        variant="ghost"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </form>
  );
}

function ThreadRowDisplay({
  deleteError,
  deleting,
  onConfirmDeleteThread,
  onDeleteThreadCancel,
  onDeleteThreadStart,
  onRenameThreadStart,
  onSelectThread,
  pendingDelete,
  selected,
  thread,
}: {
  readonly deleteError: string | null;
  readonly deleting: boolean;
  readonly onConfirmDeleteThread: () => void;
  readonly onDeleteThreadCancel: () => void;
  readonly onDeleteThreadStart: () => void;
  readonly onRenameThreadStart: () => void;
  readonly onSelectThread: (threadId: string) => void;
  readonly pendingDelete: boolean;
  readonly selected: boolean;
  readonly thread: AssistantMemoryThread;
}): ReactElement {
  return (
    <>
      <div className="flex min-w-0 items-start justify-between gap-2">
        <button
          aria-current={selected ? 'true' : undefined}
          className="min-w-0 flex-1 text-left"
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
        <div className="flex shrink-0 items-center gap-1">
          <Button
            aria-label={`Rename thread ${thread.title}`}
            onClick={onRenameThreadStart}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            aria-label={`Delete thread ${thread.title}`}
            onClick={onDeleteThreadStart}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {pendingDelete ? (
        <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 p-2">
          <p className="text-[11px] text-destructive">
            Delete this thread and its Mastra memory rows permanently?
          </p>
          {deleteError ? <p className="mt-1 text-[11px] text-destructive">{deleteError}</p> : null}
          <div className="mt-2 flex justify-end gap-2">
            <Button
              aria-label={`Cancel delete thread ${thread.title}`}
              disabled={deleting}
              onClick={onDeleteThreadCancel}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              aria-label={`Confirm delete thread ${thread.title}`}
              disabled={deleting}
              onClick={onConfirmDeleteThread}
              size="sm"
              type="button"
              variant="destructive"
            >
              Delete
            </Button>
          </div>
        </div>
      ) : null}
      <ThreadMetadataBadges thread={thread} />
    </>
  );
}

function ThreadMetadataBadges({
  thread,
}: {
  readonly thread: AssistantMemoryThread;
}): ReactElement | null {
  const providerLabel = getProviderLabel(thread.latestRun?.provider);
  const reasoningLabel = getReasoningLabel(thread);
  const maxOutputLabel = getMaxOutputLabel(thread);
  if (!(providerLabel || thread.latestRun?.model || reasoningLabel || maxOutputLabel)) {
    return null;
  }
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {providerLabel ? <ThreadBadge>{providerLabel}</ThreadBadge> : null}
      {thread.latestRun?.model ? <ThreadBadge>{thread.latestRun.model}</ThreadBadge> : null}
      {reasoningLabel ? <ThreadBadge>{reasoningLabel}</ThreadBadge> : null}
      {maxOutputLabel ? <ThreadBadge>{maxOutputLabel}</ThreadBadge> : null}
    </div>
  );
}

function ThreadBadge({ children }: { readonly children: string }): ReactElement {
  return (
    <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] text-muted-foreground">
      {children}
    </span>
  );
}

function ThreadsPanelContent({
  databaseError,
  databaseInitializing,
  loadState,
  onDeleteThread,
  onRenameThread,
  onSelectThread,
  repository,
  resourceId,
  selectedThreadId,
  threads,
}: {
  readonly databaseError: Error | null;
  readonly databaseInitializing: boolean;
  readonly loadState: ThreadPanelLoadState | null;
  readonly onDeleteThread: (threadId: string) => Promise<void>;
  readonly onRenameThread: (threadId: string, title: string) => Promise<void>;
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
  if (databaseInitializing && !repository) {
    return (
      <ThreadStateCard
        description="Reading Mastra memory from PGlite."
        testId="threads-loading-card"
        title="Loading threads..."
      />
    );
  }
  if (databaseError) {
    return (
      <ThreadStateCard
        description={databaseError.message}
        testId="threads-error-card"
        title="Assistant memory database failed"
        variant="error"
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
      onDeleteThread={onDeleteThread}
      onRenameThread={onRenameThread}
      onSelectThread={onSelectThread}
      selectedThreadId={selectedThreadId}
      threads={threads}
    />
  );
}

export function ThreadsPanel(): ReactElement {
  const database = usePGliteDatabase();
  const databaseInitializing = useDbInitializing();
  const databaseError = useDbProviderError();
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
  const deleteThread = useAssistantThreadStore((state) => state.deleteThread);
  const renameThread = useAssistantThreadStore((state) => state.renameThread);
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
  const handleRenameThread = async (threadId: string, title: string): Promise<void> => {
    if (!(repository && resourceId)) {
      return;
    }
    await renameThread(repository, resourceId, threadId, title);
  };
  const handleDeleteThread = async (threadId: string): Promise<void> => {
    if (!(repository && resourceId)) {
      return;
    }
    await deleteThread(repository, resourceId, threadId);
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
          databaseError={databaseError}
          databaseInitializing={databaseInitializing}
          loadState={loadState}
          onDeleteThread={handleDeleteThread}
          onRenameThread={handleRenameThread}
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
