import {
  useAssistantMemoryDbClient,
  useDbInitializationStatus,
  useDbInitializing,
  useDbProviderError,
} from '@brainstrike/db';
import { Button } from '@brainstrike/ui';
import {
  Bug,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Code2,
  type LucideIcon,
  MessageSquare,
  Palette,
  Pencil,
  Plus,
  Rocket,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  ASSISTANT_THREAD_COLOR_IDS,
  ASSISTANT_THREAD_ICON_IDS,
  type AssistantMemoryThread,
  type AssistantThreadColorId,
  type AssistantThreadIconId,
  type AssistantThreadMetadata,
  type AssistantThreadRepository,
  createAssistantThreadRepository,
} from './assistant-memory-repository';
import { WORKSPACE_MEMORY_RESOURCE_ID } from './assistant-memory-resource';
import { shouldRenderAssistantThreadDatabaseStartupLoading } from './assistant-thread-database-state';
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

const THREAD_ICON_CONFIG = {
  message: { label: 'Message', iconComponent: MessageSquare },
  bug: { label: 'Bug', iconComponent: Bug },
  code: { label: 'Code', iconComponent: Code2 },
  rocket: { label: 'Rocket', iconComponent: Rocket },
  research: { label: 'Research', iconComponent: Search },
  plan: { label: 'Plan', iconComponent: ClipboardList },
} satisfies Record<
  AssistantThreadIconId,
  { readonly iconComponent: LucideIcon; readonly label: string }
>;

const THREAD_COLOR_CONFIG = {
  blue: {
    accentClassName: 'bg-sky-500',
    label: 'Blue',
    markClassName:
      'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300',
    selectedClassName: 'border-sky-300 bg-sky-50/70 dark:border-sky-800 dark:bg-sky-950/20',
  },
  emerald: {
    accentClassName: 'bg-emerald-500',
    label: 'Emerald',
    markClassName:
      'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
    selectedClassName:
      'border-emerald-300 bg-emerald-50/70 dark:border-emerald-800 dark:bg-emerald-950/20',
  },
  amber: {
    accentClassName: 'bg-amber-500',
    label: 'Amber',
    markClassName:
      'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
    selectedClassName: 'border-amber-300 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/20',
  },
  rose: {
    accentClassName: 'bg-rose-500',
    label: 'Rose',
    markClassName:
      'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300',
    selectedClassName: 'border-rose-300 bg-rose-50/70 dark:border-rose-800 dark:bg-rose-950/20',
  },
  violet: {
    accentClassName: 'bg-violet-500',
    label: 'Violet',
    markClassName:
      'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300',
    selectedClassName:
      'border-violet-300 bg-violet-50/70 dark:border-violet-800 dark:bg-violet-950/20',
  },
  slate: {
    accentClassName: 'bg-slate-500',
    label: 'Slate',
    markClassName:
      'border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-300',
    selectedClassName: 'border-slate-300 bg-slate-50/70 dark:border-slate-700 dark:bg-slate-900/30',
  },
} satisfies Record<
  AssistantThreadColorId,
  {
    readonly accentClassName: string;
    readonly label: string;
    readonly markClassName: string;
    readonly selectedClassName: string;
  }
>;

function getProviderLabel(provider: string | undefined): string | null {
  if (!provider) {
    return null;
  }
  return PROVIDER_LABELS[provider] ?? provider;
}

function getThreadIconId(thread: AssistantMemoryThread): AssistantThreadIconId {
  return thread.metadata?.icon ?? 'message';
}

function getThreadColorId(thread: AssistantMemoryThread): AssistantThreadColorId {
  return thread.metadata?.color ?? 'blue';
}

function getReasoningValue(thread: AssistantMemoryThread): string | null {
  const provider = thread.latestRun?.provider;
  const providerOptions = thread.latestRun?.providerOptions;
  const providerRecord =
    provider && providerOptions && typeof providerOptions[provider] === 'object'
      ? (providerOptions[provider] as Record<string, unknown>)
      : null;
  const reasoning = providerRecord?.['reasoningEffort'] ?? providerRecord?.['effort'];
  return typeof reasoning === 'string' && reasoning.trim() ? reasoning : null;
}

function getReasoningLabel(thread: AssistantMemoryThread): string | null {
  const value = getReasoningValue(thread);
  return value ? `Reasoning: ${value}` : null;
}

function getMaxOutputValue(thread: AssistantMemoryThread): string | null {
  const value = thread.latestRun?.modelSettings?.['maxOutputTokens'];
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}

function getMaxOutputLabel(thread: AssistantMemoryThread): string | null {
  const value = getMaxOutputValue(thread);
  return value ? `Max output: ${value}` : null;
}

function formatThreadDate(value: Date): string {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value);
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
  onUpdateThreadMetadata,
  selectedThreadId,
  threads,
}: {
  readonly onDeleteThread: (threadId: string) => Promise<void>;
  readonly onRenameThread: (threadId: string, title: string) => Promise<void>;
  readonly onSelectThread: (threadId: string) => void;
  readonly onUpdateThreadMetadata: (
    threadId: string,
    metadata: AssistantThreadMetadata
  ) => Promise<void>;
  readonly selectedThreadId: string | undefined;
  readonly threads: readonly AssistantMemoryThread[];
}): ReactElement {
  const [customizingThreadId, setCustomizingThreadId] = useState<string | null>(null);
  const [confirmingDeleteThreadId, setConfirmingDeleteThreadId] = useState<string | null>(null);
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [expandedThreadIds, setExpandedThreadIds] = useState<ReadonlySet<string>>(() => new Set());
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState<string>('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [savingMetadataThreadId, setSavingMetadataThreadId] = useState<string | null>(null);
  const [savingThreadId, setSavingThreadId] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      {threads.map((thread) => (
        <ThreadRowItem
          confirmingDeleteThreadId={confirmingDeleteThreadId}
          customizingThreadId={customizingThreadId}
          deleteError={deleteError}
          deletingThreadId={deletingThreadId}
          draftTitle={draftTitle}
          editingThreadId={editingThreadId}
          expandedThreadIds={expandedThreadIds}
          key={thread.id}
          metadataError={metadataError}
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
          onCustomizeThreadToggle={() => {
            setCustomizingThreadId((currentThreadId) =>
              currentThreadId === thread.id ? null : thread.id
            );
            setMetadataError(null);
          }}
          onDeleteThreadCancel={() => {
            setConfirmingDeleteThreadId(null);
            setDeleteError(null);
          }}
          onDeleteThreadStart={() => {
            setConfirmingDeleteThreadId(thread.id);
            setDeleteError(null);
            setCustomizingThreadId(null);
          }}
          onDraftTitleChange={setDraftTitle}
          onExpandedThreadToggle={() => {
            setExpandedThreadIds((currentThreadIds) => {
              const nextThreadIds = new Set(currentThreadIds);
              if (nextThreadIds.has(thread.id)) {
                nextThreadIds.delete(thread.id);
              } else {
                nextThreadIds.add(thread.id);
              }
              return nextThreadIds;
            });
          }}
          onMetadataError={setMetadataError}
          onRenameThread={onRenameThread}
          onRenameThreadStart={() => {
            setEditingThreadId(thread.id);
            setDraftTitle(thread.title);
            setRenameError(null);
            setCustomizingThreadId(null);
          }}
          onRenameThreadSubmitError={setRenameError}
          onRenameThreadSubmitted={() => {
            setEditingThreadId(null);
            setDraftTitle('');
          }}
          onSavingMetadataThreadIdChange={setSavingMetadataThreadId}
          onSavingThreadIdChange={setSavingThreadId}
          onSelectThread={onSelectThread}
          onUpdateThreadMetadata={onUpdateThreadMetadata}
          renameError={renameError}
          savingMetadataThreadId={savingMetadataThreadId}
          savingThreadId={savingThreadId}
          selectedThreadId={selectedThreadId}
          thread={thread}
        />
      ))}
    </div>
  );
}

function ThreadRowItem({
  customizingThreadId,
  confirmingDeleteThreadId,
  deletingThreadId,
  deleteError,
  draftTitle,
  editingThreadId,
  expandedThreadIds,
  metadataError,
  onCancelRename,
  onCustomizeThreadToggle,
  onConfirmDeleteThread,
  onDeleteThreadCancel,
  onDeleteThreadStart,
  onDraftTitleChange,
  onExpandedThreadToggle,
  onMetadataError,
  onRenameThread,
  onRenameThreadStart,
  onRenameThreadSubmitted,
  onRenameThreadSubmitError,
  onSavingMetadataThreadIdChange,
  onSavingThreadIdChange,
  onSelectThread,
  onUpdateThreadMetadata,
  renameError,
  savingMetadataThreadId,
  savingThreadId,
  selectedThreadId,
  thread,
}: {
  readonly customizingThreadId: string | null;
  readonly confirmingDeleteThreadId: string | null;
  readonly deletingThreadId: string | null;
  readonly deleteError: string | null;
  readonly draftTitle: string;
  readonly editingThreadId: string | null;
  readonly expandedThreadIds: ReadonlySet<string>;
  readonly metadataError: string | null;
  readonly onCancelRename: () => void;
  readonly onCustomizeThreadToggle: () => void;
  readonly onConfirmDeleteThread: () => void;
  readonly onDeleteThreadCancel: () => void;
  readonly onDeleteThreadStart: () => void;
  readonly onDraftTitleChange: (title: string) => void;
  readonly onExpandedThreadToggle: () => void;
  readonly onMetadataError: (message: string | null) => void;
  readonly onRenameThread: (threadId: string, title: string) => Promise<void>;
  readonly onRenameThreadStart: () => void;
  readonly onRenameThreadSubmitted: () => void;
  readonly onRenameThreadSubmitError: (message: string) => void;
  readonly onSavingMetadataThreadIdChange: (threadId: string | null) => void;
  readonly onSavingThreadIdChange: (threadId: string | null) => void;
  readonly onSelectThread: (threadId: string) => void;
  readonly onUpdateThreadMetadata: (
    threadId: string,
    metadata: AssistantThreadMetadata
  ) => Promise<void>;
  readonly renameError: string | null;
  readonly savingMetadataThreadId: string | null;
  readonly savingThreadId: string | null;
  readonly selectedThreadId: string | undefined;
  readonly thread: AssistantMemoryThread;
}): ReactElement {
  const isSelected = selectedThreadId === thread.id;
  const isEditing = editingThreadId === thread.id;
  const isConfirmingDelete = confirmingDeleteThreadId === thread.id;
  const isCustomizing = customizingThreadId === thread.id;
  const isExpanded = expandedThreadIds.has(thread.id);
  const colorId = getThreadColorId(thread);
  const colorConfig = THREAD_COLOR_CONFIG[colorId];
  return (
    <div
      className={`relative w-full overflow-hidden rounded-lg border px-3 py-2 text-left transition-colors ${
        isSelected ? colorConfig.selectedClassName : 'border-border bg-background'
      }`}
      data-testid="thread-row"
    >
      <div
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-1 ${colorConfig.accentClassName}`}
      />
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
          customizing={isCustomizing}
          deleteError={isConfirmingDelete ? deleteError : null}
          deleting={deletingThreadId === thread.id}
          expanded={isExpanded}
          metadataError={isCustomizing ? metadataError : null}
          metadataSaving={savingMetadataThreadId === thread.id}
          onConfirmDeleteThread={onConfirmDeleteThread}
          onCustomizeThreadToggle={onCustomizeThreadToggle}
          onDeleteThreadCancel={onDeleteThreadCancel}
          onDeleteThreadStart={onDeleteThreadStart}
          onExpandedThreadToggle={onExpandedThreadToggle}
          onMetadataError={onMetadataError}
          onRenameThreadStart={onRenameThreadStart}
          onSavingMetadataThreadIdChange={onSavingMetadataThreadIdChange}
          onSelectThread={onSelectThread}
          onUpdateThreadMetadata={onUpdateThreadMetadata}
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
      className="flex min-h-10 items-center gap-2"
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
      <ThreadIdentityMark thread={thread} />
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
  customizing,
  deleteError,
  deleting,
  expanded,
  metadataError,
  metadataSaving,
  onCustomizeThreadToggle,
  onConfirmDeleteThread,
  onDeleteThreadCancel,
  onDeleteThreadStart,
  onExpandedThreadToggle,
  onMetadataError,
  onRenameThreadStart,
  onSavingMetadataThreadIdChange,
  onSelectThread,
  onUpdateThreadMetadata,
  pendingDelete,
  selected,
  thread,
}: {
  readonly customizing: boolean;
  readonly deleteError: string | null;
  readonly deleting: boolean;
  readonly expanded: boolean;
  readonly metadataError: string | null;
  readonly metadataSaving: boolean;
  readonly onCustomizeThreadToggle: () => void;
  readonly onConfirmDeleteThread: () => void;
  readonly onDeleteThreadCancel: () => void;
  readonly onDeleteThreadStart: () => void;
  readonly onExpandedThreadToggle: () => void;
  readonly onMetadataError: (message: string | null) => void;
  readonly onRenameThreadStart: () => void;
  readonly onSavingMetadataThreadIdChange: (threadId: string | null) => void;
  readonly onSelectThread: (threadId: string) => void;
  readonly onUpdateThreadMetadata: (
    threadId: string,
    metadata: AssistantThreadMetadata
  ) => Promise<void>;
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
          <div className="grid min-w-0 grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2">
            <div className="flex min-h-10 items-center">
              <ThreadIdentityMark thread={thread} />
            </div>
            <div className="flex min-h-10 min-w-0 items-center">
              <div className="truncate font-medium text-xs">{thread.title}</div>
            </div>
            <div className="col-start-2 min-w-0">
              <ThreadMetadataBadges thread={thread} />
            </div>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            aria-label={`${expanded ? 'Hide' : 'Show'} thread details ${thread.title}`}
            onClick={onExpandedThreadToggle}
            size="icon"
            type="button"
            variant="ghost"
          >
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            aria-label={`Customize thread ${thread.title}`}
            onClick={onCustomizeThreadToggle}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Palette className="h-3.5 w-3.5" />
          </Button>
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
      {customizing ? (
        <ThreadCustomizationPanel
          metadataError={metadataError}
          metadataSaving={metadataSaving}
          onMetadataError={onMetadataError}
          onSavingMetadataThreadIdChange={onSavingMetadataThreadIdChange}
          onUpdateThreadMetadata={onUpdateThreadMetadata}
          thread={thread}
        />
      ) : null}
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
      {expanded ? <ThreadExpandedDetails thread={thread} /> : null}
    </>
  );
}

function ThreadIdentityMark({ thread }: { readonly thread: AssistantMemoryThread }): ReactElement {
  const iconId = getThreadIconId(thread);
  const colorId = getThreadColorId(thread);
  const Icon = THREAD_ICON_CONFIG[iconId].iconComponent;
  return (
    <span
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${THREAD_COLOR_CONFIG[colorId].markClassName}`}
      data-testid={`thread-color-${colorId}`}
    >
      <Icon className="h-3.5 w-3.5" data-testid={`thread-icon-${iconId}`} />
    </span>
  );
}

function ThreadCustomizationPanel({
  metadataError,
  metadataSaving,
  onMetadataError,
  onSavingMetadataThreadIdChange,
  onUpdateThreadMetadata,
  thread,
}: {
  readonly metadataError: string | null;
  readonly metadataSaving: boolean;
  readonly onMetadataError: (message: string | null) => void;
  readonly onSavingMetadataThreadIdChange: (threadId: string | null) => void;
  readonly onUpdateThreadMetadata: (
    threadId: string,
    metadata: AssistantThreadMetadata
  ) => Promise<void>;
  readonly thread: AssistantMemoryThread;
}): ReactElement {
  const saveMetadata = (metadata: AssistantThreadMetadata): void => {
    onSavingMetadataThreadIdChange(thread.id);
    onMetadataError(null);
    onUpdateThreadMetadata(thread.id, metadata)
      .catch((error: unknown) => {
        onMetadataError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        onSavingMetadataThreadIdChange(null);
      });
  };
  return (
    <div className="mt-2 rounded-md border border-border bg-muted/30 p-2">
      <div className="grid gap-2">
        <div>
          <div className="mb-1 text-[11px] text-muted-foreground">Icon</div>
          <div className="flex flex-wrap gap-1">
            {ASSISTANT_THREAD_ICON_IDS.map((iconId) => {
              const Icon = THREAD_ICON_CONFIG[iconId].iconComponent;
              const label = THREAD_ICON_CONFIG[iconId].label;
              const selected = getThreadIconId(thread) === iconId;
              return (
                <Button
                  aria-label={`Use ${label} icon`}
                  className={selected ? 'border-primary/50 bg-primary/10' : undefined}
                  disabled={metadataSaving}
                  key={iconId}
                  onClick={() => {
                    saveMetadata({ icon: iconId });
                  }}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <Icon className="h-3.5 w-3.5" />
                </Button>
              );
            })}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[11px] text-muted-foreground">Color</div>
          <div className="flex flex-wrap gap-1">
            {ASSISTANT_THREAD_COLOR_IDS.map((colorId) => {
              const label = THREAD_COLOR_CONFIG[colorId].label;
              const selected = getThreadColorId(thread) === colorId;
              return (
                <Button
                  aria-label={`Use ${label} color`}
                  className={selected ? 'border-primary/50 bg-primary/10' : undefined}
                  disabled={metadataSaving}
                  key={colorId}
                  onClick={() => {
                    saveMetadata({ color: colorId });
                  }}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <span
                    className={`h-3.5 w-3.5 rounded-full ${THREAD_COLOR_CONFIG[colorId].accentClassName}`}
                  />
                </Button>
              );
            })}
          </div>
        </div>
      </div>
      {metadataError ? <p className="mt-2 text-[11px] text-destructive">{metadataError}</p> : null}
    </div>
  );
}

function ThreadExpandedDetails({
  thread,
}: {
  readonly thread: AssistantMemoryThread;
}): ReactElement {
  const providerLabel = getProviderLabel(thread.latestRun?.provider);
  const reasoningValue = getReasoningValue(thread);
  const maxOutputValue = getMaxOutputValue(thread);
  return (
    <div
      className="mt-2 rounded-md border border-border bg-background/70 p-2"
      data-testid="thread-expanded-details"
    >
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
        {providerLabel ? <ThreadDetail label="Provider" value={providerLabel} /> : null}
        {thread.latestRun?.model ? (
          <ThreadDetail label="Model" value={thread.latestRun.model} />
        ) : null}
        {thread.latestRun?.runtimeKind ? (
          <ThreadDetail label="Runtime" value={thread.latestRun.runtimeKind} />
        ) : null}
        {thread.latestRun?.status ? (
          <ThreadDetail label="Status" value={thread.latestRun.status} />
        ) : null}
        {reasoningValue ? <ThreadDetail label="Reasoning" value={reasoningValue} /> : null}
        {maxOutputValue ? <ThreadDetail label="Max output" value={maxOutputValue} /> : null}
        <ThreadDetail label="Created" value={formatThreadDate(thread.createdAt)} />
        <ThreadDetail label="Updated" value={formatThreadDate(thread.updatedAt)} />
      </div>
      <div className="mt-2 border-border border-t pt-2">
        <div className="font-medium text-[11px] text-muted-foreground">Diagnostics</div>
        <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
          {thread.id}
        </div>
      </div>
    </div>
  );
}

function ThreadDetail({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactElement {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="truncate font-medium">{value}</div>
    </div>
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
  databaseStartupLoading,
  loadState,
  onDeleteThread,
  onRenameThread,
  onSelectThread,
  onUpdateThreadMetadata,
  repository,
  selectedThreadId,
  threads,
}: {
  readonly databaseError: Error | null;
  readonly databaseStartupLoading: boolean;
  readonly loadState: ThreadPanelLoadState | null;
  readonly onDeleteThread: (threadId: string) => Promise<void>;
  readonly onRenameThread: (threadId: string, title: string) => Promise<void>;
  readonly onSelectThread: (threadId: string) => void;
  readonly onUpdateThreadMetadata: (
    threadId: string,
    metadata: AssistantThreadMetadata
  ) => Promise<void>;
  readonly repository: AssistantThreadRepository | null;
  readonly selectedThreadId: string | undefined;
  readonly threads: readonly AssistantMemoryThread[];
}): ReactElement {
  if (!repository && databaseStartupLoading) {
    return (
      <ThreadStateCard
        description="Reading Mastra memory from the database."
        testId="threads-loading-card"
        title="Loading threads..."
      />
    );
  }
  if (!repository && databaseError) {
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
        description="The assistant is unavailable until memory initializes."
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
        description="Reading Mastra memory from the database."
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
      onUpdateThreadMetadata={onUpdateThreadMetadata}
      selectedThreadId={selectedThreadId}
      threads={threads}
    />
  );
}

export function ThreadsPanel(): ReactElement {
  const database = useAssistantMemoryDbClient();
  const databaseInitializing = useDbInitializing();
  const databaseStatus = useDbInitializationStatus();
  const databaseError = useDbProviderError();
  // Assistant memory is workspace-global: one stable resource id, never the
  // focused root path. Keying on the focused root wiped threads on focus change
  // (e.g. adding a folder) and gated the assistant behind "open a folder first".
  // See assistant-memory-resource.ts.
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
  const updateThreadMetadata = useAssistantThreadStore((state) => state.updateThreadMetadata);
  const selectedThreadId = selectedThreadByResourceId[resourceId];
  const threads = threadsByResourceId[resourceId] ?? [];
  const loadState = loadStateByResourceId[resourceId] ?? { status: 'idle' };
  const handleSelectThread = (threadId: string): void => {
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
  const handleUpdateThreadMetadata = async (
    threadId: string,
    metadata: AssistantThreadMetadata
  ): Promise<void> => {
    if (!(repository && resourceId)) {
      return;
    }
    await updateThreadMetadata(repository, resourceId, threadId, metadata);
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
            repository
              ? 'Create a new Mastra memory thread for this workspace.'
              : 'The assistant memory database is still initializing.'
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
          databaseStartupLoading={databaseStartupLoading}
          loadState={loadState}
          onDeleteThread={handleDeleteThread}
          onRenameThread={handleRenameThread}
          onSelectThread={handleSelectThread}
          onUpdateThreadMetadata={handleUpdateThreadMetadata}
          repository={repository}
          selectedThreadId={selectedThreadId}
          threads={threads}
        />
      </div>
    </section>
  );
}
