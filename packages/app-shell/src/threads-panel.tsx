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
import {
  ActionContextMenu,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  useContextMenuTarget,
} from '@brainstrike/ui';
import {
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ClipboardList,
  Code2,
  Folder,
  FolderMinus,
  FolderPlus,
  type LucideIcon,
  MessageSquare,
  Palette,
  Pencil,
  Plus,
  Rocket,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ASSISTANT_THREAD_COLOR_IDS,
  ASSISTANT_THREAD_ICON_IDS,
  type AssistantMemoryThread,
  type AssistantThreadColorId,
  type AssistantThreadIconId,
  type AssistantThreadMetadata,
  type AssistantThreadRepository,
  createPgliteAssistantThreadRepository,
} from './assistant-memory-repository';
import { WORKSPACE_MEMORY_RESOURCE_ID } from './assistant-memory-resource';
import { assistantThreadToTarget } from './assistant-thread-context-actions';
import { shouldRenderAssistantThreadDatabaseStartupLoading } from './assistant-thread-database-state';
import {
  type AssistantThreadGroup,
  createPgliteAssistantThreadGroupsRepository,
} from './assistant-thread-groups-repository';
import { useAssistantThreadGroupsStore } from './assistant-thread-groups-store';
import { useAssistantThreadStore } from './assistant-thread-store';
import {
  buildThreadListSections,
  buildThreadMembership,
  type ThreadListView,
  type ThreadsPanelGroupBy,
  type ThreadsPanelSortBy,
} from './thread-list-sections';
import {
  resolveThreadsPanelDrop,
  type ThreadsPanelDragSource,
  type ThreadsPanelDropTarget,
} from './threads-panel-dnd';
import {
  GroupBodyDndShell,
  GroupHeaderDndShell,
  ThreadRowDndShell,
  UngroupedSectionDndShell,
  useThreadsPanelDropMonitor,
} from './threads-panel-dnd-elements';

// Stable fallback so `threads` keeps referential identity across renders when
// the resource has no entry yet (the membership/view useMemos depend on it).
const EMPTY_THREADS: readonly AssistantMemoryThread[] = [];

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
  bug: { iconComponent: Bug, label: 'Bug' },
  code: { iconComponent: Code2, label: 'Code' },
  message: { iconComponent: MessageSquare, label: 'Message' },
  plan: { iconComponent: ClipboardList, label: 'Plan' },
  research: { iconComponent: Search, label: 'Research' },
  rocket: { iconComponent: Rocket, label: 'Rocket' },
} satisfies Record<
  AssistantThreadIconId,
  { readonly iconComponent: LucideIcon; readonly label: string }
>;

const THREAD_COLOR_CONFIG = {
  amber: {
    accentClassName: 'bg-amber-500',
    label: 'Amber',
    markClassName:
      'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
    selectedClassName: 'border-amber-300 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/20',
  },
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
  rose: {
    accentClassName: 'bg-rose-500',
    label: 'Rose',
    markClassName:
      'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300',
    selectedClassName: 'border-rose-300 bg-rose-50/70 dark:border-rose-800 dark:bg-rose-950/20',
  },
  slate: {
    accentClassName: 'bg-slate-500',
    label: 'Slate',
    markClassName:
      'border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-300',
    selectedClassName: 'border-slate-300 bg-slate-50/70 dark:border-slate-700 dark:bg-slate-900/30',
  },
  violet: {
    accentClassName: 'bg-violet-500',
    label: 'Violet',
    markClassName:
      'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300',
    selectedClassName:
      'border-violet-300 bg-violet-50/70 dark:border-violet-800 dark:bg-violet-950/20',
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

interface ThreadMoveTarget {
  readonly id: string;
  readonly name: string;
}

function ThreadRows({
  membershipByThreadId,
  moveTargets,
  onDeleteThread,
  onMoveThreadToGroup,
  onRenameThread,
  onSelectThread,
  onUpdateThreadMetadata,
  selectedThreadId,
  threads,
}: {
  readonly membershipByThreadId: ReadonlyMap<string, string | null>;
  readonly moveTargets: readonly ThreadMoveTarget[];
  readonly onDeleteThread: (threadId: string) => Promise<void>;
  readonly onMoveThreadToGroup: (threadId: string, groupId: string | null) => Promise<void>;
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
        <ThreadRowDndShell
          groupId={membershipByThreadId.get(thread.id) ?? null}
          key={thread.id}
          threadId={thread.id}
        >
          <ThreadRowItem
            confirmingDeleteThreadId={confirmingDeleteThreadId}
            customizingThreadId={customizingThreadId}
            deleteError={deleteError}
            deletingThreadId={deletingThreadId}
            draftTitle={draftTitle}
            editingThreadId={editingThreadId}
            expandedThreadIds={expandedThreadIds}
            metadataError={metadataError}
            moveTargets={moveTargets}
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
            onMoveThreadToGroup={onMoveThreadToGroup}
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
            rowGroupId={membershipByThreadId.get(thread.id) ?? null}
            savingMetadataThreadId={savingMetadataThreadId}
            savingThreadId={savingThreadId}
            selectedThreadId={selectedThreadId}
            thread={thread}
          />
        </ThreadRowDndShell>
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
  moveTargets,
  onCancelRename,
  onCustomizeThreadToggle,
  onConfirmDeleteThread,
  onDeleteThreadCancel,
  onDeleteThreadStart,
  onDraftTitleChange,
  onExpandedThreadToggle,
  onMetadataError,
  onMoveThreadToGroup,
  onRenameThread,
  onRenameThreadStart,
  onRenameThreadSubmitted,
  onRenameThreadSubmitError,
  onSavingMetadataThreadIdChange,
  onSavingThreadIdChange,
  onSelectThread,
  onUpdateThreadMetadata,
  renameError,
  rowGroupId,
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
  readonly moveTargets: readonly ThreadMoveTarget[];
  readonly onCancelRename: () => void;
  readonly onCustomizeThreadToggle: () => void;
  readonly onConfirmDeleteThread: () => void;
  readonly onDeleteThreadCancel: () => void;
  readonly onDeleteThreadStart: () => void;
  readonly onDraftTitleChange: (title: string) => void;
  readonly onExpandedThreadToggle: () => void;
  readonly onMetadataError: (message: string | null) => void;
  readonly onMoveThreadToGroup: (threadId: string, groupId: string | null) => Promise<void>;
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
  readonly rowGroupId: string | null;
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
  const contextMenuController = useContextMenuTarget();
  const { setTarget: setContextMenuTarget } = contextMenuController;
  const rowActions = useMemo<readonly AnyContextAction[]>(() => {
    const isCurrentTarget = (target: TargetOf<'assistant-thread'>): boolean =>
      target.id === thread.id && target.resourceId === thread.resourceId;
    const staleTargetFailure = Promise.resolve({
      error: 'Thread row is no longer available',
      ok: false as const,
    });

    return [
      defineContextAction({
        appliesTo: ['assistant-thread'] as const,
        group: 'primary',
        icon: MessageSquare,
        id: 'assistant-thread.open',
        isEnabled: (target) => isCurrentTarget(target) && !isSelected,
        label: 'Open',
        run: (target) => {
          if (!isCurrentTarget(target)) {
            return staleTargetFailure;
          }
          onSelectThread(target.id);
          return Promise.resolve({ ok: true });
        },
      }),
      defineContextAction({
        appliesTo: ['assistant-thread'] as const,
        group: 'primary',
        icon: Pencil,
        id: 'assistant-thread.rename',
        isEnabled: (target) => isCurrentTarget(target),
        label: 'Rename…',
        run: (target) => {
          if (!isCurrentTarget(target)) {
            return staleTargetFailure;
          }
          onRenameThreadStart();
          return Promise.resolve({ ok: true });
        },
      }),
      defineContextAction({
        appliesTo: ['assistant-thread'] as const,
        group: 'primary',
        icon: Palette,
        id: 'assistant-thread.customize',
        isEnabled: (target) => isCurrentTarget(target),
        label: isCustomizing ? 'Close Customization' : 'Customize…',
        run: (target) => {
          if (!isCurrentTarget(target)) {
            return staleTargetFailure;
          }
          onCustomizeThreadToggle();
          return Promise.resolve({ ok: true });
        },
      }),
      defineContextAction({
        appliesTo: ['assistant-thread'] as const,
        group: 'inspect',
        icon: isExpanded ? ChevronUp : ChevronDown,
        id: 'assistant-thread.toggle-details',
        isEnabled: (target) => isCurrentTarget(target),
        label: isExpanded ? 'Hide Details' : 'Show Details',
        run: (target) => {
          if (!isCurrentTarget(target)) {
            return staleTargetFailure;
          }
          onExpandedThreadToggle();
          return Promise.resolve({ ok: true });
        },
      }),
      ...moveTargets.flatMap((moveTarget) =>
        moveTarget.id === rowGroupId
          ? []
          : defineContextAction({
              appliesTo: ['assistant-thread'] as const,
              group: 'tree',
              icon: Folder,
              id: `assistant-thread.move-to-group.${moveTarget.id}`,
              isEnabled: (target) => isCurrentTarget(target),
              label: `Move to ${moveTarget.name}`,
              run: (target) => {
                if (!isCurrentTarget(target)) {
                  return staleTargetFailure;
                }
                return onMoveThreadToGroup(target.id, moveTarget.id).then(
                  () => ({ ok: true as const }),
                  (error: unknown) => ({
                    error: error instanceof Error ? error.message : String(error),
                    ok: false as const,
                  })
                );
              },
            })
      ),
      ...(rowGroupId
        ? [
            defineContextAction({
              appliesTo: ['assistant-thread'] as const,
              group: 'tree',
              icon: FolderMinus,
              id: 'assistant-thread.remove-from-group',
              isEnabled: (target) => isCurrentTarget(target),
              label: 'Remove from Group',
              run: (target) => {
                if (!isCurrentTarget(target)) {
                  return staleTargetFailure;
                }
                return onMoveThreadToGroup(target.id, null).then(
                  () => ({ ok: true as const }),
                  (error: unknown) => ({
                    error: error instanceof Error ? error.message : String(error),
                    ok: false as const,
                  })
                );
              },
            }),
          ]
        : []),
      defineContextAction({
        appliesTo: ['assistant-thread'] as const,
        group: 'danger',
        icon: Trash2,
        id: 'assistant-thread.delete',
        isEnabled: (target) => isCurrentTarget(target) && !isConfirmingDelete,
        label: 'Delete…',
        run: (target) => {
          if (!isCurrentTarget(target)) {
            return staleTargetFailure;
          }
          onDeleteThreadStart();
          return Promise.resolve({ ok: true });
        },
      }),
    ];
  }, [
    isConfirmingDelete,
    isCustomizing,
    isExpanded,
    isSelected,
    moveTargets,
    onCustomizeThreadToggle,
    onDeleteThreadStart,
    onExpandedThreadToggle,
    onMoveThreadToGroup,
    onRenameThreadStart,
    onSelectThread,
    rowGroupId,
    thread.id,
    thread.resourceId,
  ]);
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
        <ActionContextMenu controller={contextMenuController} localActions={rowActions}>
          {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: layout-neutral wrapper claims a resource-scoped thread context target */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: layout-neutral wrapper delegates all activation to the menu */}
          <div
            className="contents"
            onContextMenu={() =>
              setContextMenuTarget(assistantThreadToTarget(thread, 'assistant-thread'))
            }
            onContextMenuCapture={() => setContextMenuTarget(null)}
          >
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
          </div>
        </ActionContextMenu>
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

const GROUP_BY_OPTIONS: readonly { readonly label: string; readonly value: ThreadsPanelGroupBy }[] =
  [
    { label: 'Custom groups', value: 'custom-groups' },
    { label: 'No grouping', value: 'none' },
  ];

const SORT_BY_OPTIONS: readonly { readonly label: string; readonly value: ThreadsPanelSortBy }[] = [
  { label: 'Recency', value: 'recency' },
  { label: 'Name', value: 'name' },
  { label: 'Custom', value: 'custom' },
];

function ViewOptionRadio({
  checked,
  label,
  onSelect,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onSelect: () => void;
}): ReactElement {
  return (
    <label
      className={`flex w-full cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent ${
        checked ? 'bg-accent/60 font-medium' : ''
      }`}
    >
      <input checked={checked} className="sr-only" onChange={onSelect} type="radio" value={label} />
      <span>{label}</span>
      {checked ? <Check className="h-3.5 w-3.5" /> : null}
    </label>
  );
}

function ThreadsViewOptionsPopover({
  groupBy,
  onGroupByChange,
  onSortByChange,
  sortBy,
}: {
  readonly groupBy: ThreadsPanelGroupBy;
  readonly onGroupByChange: (groupBy: ThreadsPanelGroupBy) => void;
  readonly onSortByChange: (sortBy: ThreadsPanelSortBy) => void;
  readonly sortBy: ThreadsPanelSortBy;
}): ReactElement {
  const hasNonDefaultView = groupBy !== 'custom-groups' || sortBy !== 'recency';
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label="View options"
          className="relative h-8 w-8 p-0"
          size="sm"
          title="View options"
          type="button"
          variant="ghost"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {hasNonDefaultView ? (
            <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-primary" />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-52 p-2">
        <div className="grid gap-2">
          <div aria-label="Group by" role="radiogroup">
            <div className="px-2 pb-1 text-[11px] text-muted-foreground">Group by</div>
            {GROUP_BY_OPTIONS.map((option) => (
              <ViewOptionRadio
                checked={groupBy === option.value}
                key={option.value}
                label={option.label}
                onSelect={() => onGroupByChange(option.value)}
              />
            ))}
          </div>
          <div aria-label="Sort by" role="radiogroup">
            <div className="px-2 pb-1 text-[11px] text-muted-foreground">Sort by</div>
            {SORT_BY_OPTIONS.map((option) => (
              <ViewOptionRadio
                checked={sortBy === option.value}
                key={option.value}
                label={option.label}
                onSelect={() => onSortByChange(option.value)}
              />
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ThreadGroupRenameForm({
  draftName,
  onCancel,
  onDraftNameChange,
  onSubmit,
  saving,
}: {
  readonly draftName: string;
  readonly onCancel: () => void;
  readonly onDraftNameChange: (name: string) => void;
  readonly onSubmit: () => void;
  readonly saving: boolean;
}): ReactElement {
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <input
        aria-label="Group name"
        // biome-ignore lint/a11y/noAutofocus: inline rename is opened by an explicit user action; focusing the field is the whole point
        autoFocus
        className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => {
          onDraftNameChange(event.target.value);
        }}
        value={draftName}
      />
      <Button
        aria-label="Save group name"
        disabled={saving}
        size="icon"
        type="submit"
        variant="ghost"
      >
        <Check className="h-3.5 w-3.5" />
      </Button>
      <Button
        aria-label="Cancel group rename"
        onClick={onCancel}
        size="icon"
        type="button"
        variant="ghost"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </form>
  );
}

function ThreadGroupHeader({
  collapsed,
  group,
  onDeleteGroup,
  onRenameGroupStart,
  onToggleCollapsed,
  renameForm,
  threadCount,
}: {
  readonly collapsed: boolean;
  readonly group: AssistantThreadGroup;
  readonly onDeleteGroup: () => void;
  readonly onRenameGroupStart: () => void;
  readonly onToggleCollapsed: () => void;
  readonly renameForm: ReactElement | null;
  readonly threadCount: number;
}): ReactElement {
  return (
    <div
      className="group/thread-group flex min-h-8 items-center gap-1 px-1"
      data-testid="thread-group-header"
    >
      <Button
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} group ${group.name}`}
        className="h-6 w-6 shrink-0 p-0"
        onClick={onToggleCollapsed}
        size="sm"
        type="button"
        variant="ghost"
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5" />
        )}
      </Button>
      <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      {renameForm ?? (
        <>
          <span className="min-w-0 truncate font-medium text-xs">{group.name}</span>
          <span
            className="rounded-full border border-border bg-background px-1.5 text-[10px] text-muted-foreground"
            data-testid="thread-group-count"
          >
            {threadCount}
          </span>
          <span className="min-w-0 flex-1" />
          <span className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/thread-group:opacity-100">
            <Button
              aria-label={`Rename group ${group.name}`}
              className="h-6 w-6 p-0"
              onClick={onRenameGroupStart}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Pencil className="h-3 w-3" />
            </Button>
            <Button
              aria-label={`Delete group ${group.name}`}
              className="h-6 w-6 p-0"
              onClick={onDeleteGroup}
              size="sm"
              title="Delete group (threads return to Ungrouped)"
              type="button"
              variant="ghost"
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </span>
        </>
      )}
    </div>
  );
}

interface ThreadGroupSectionHandlers {
  readonly collapsedGroupIds: Record<string, true>;
  readonly onDeleteGroup: (groupId: string) => void;
  readonly onGroupRenameCancel: () => void;
  readonly onGroupRenameDraftChange: (name: string) => void;
  readonly onGroupRenameStart: (group: AssistantThreadGroup) => void;
  readonly onGroupRenameSubmit: () => void;
  readonly onToggleGroupCollapsed: (groupId: string) => void;
  readonly renamingGroupDraftName: string;
  readonly renamingGroupId: string | null;
  readonly savingGroupId: string | null;
}

function ThreadsPanelContent({
  databaseError,
  databaseStartupLoading,
  groupHandlers,
  loadState,
  membershipByThreadId,
  moveTargets,
  onDeleteThread,
  onMoveThreadToGroup,
  onRenameThread,
  onSelectThread,
  onUpdateThreadMetadata,
  repository,
  selectedThreadId,
  threads,
  view,
}: {
  readonly databaseError: Error | null;
  readonly databaseStartupLoading: boolean;
  readonly groupHandlers: ThreadGroupSectionHandlers;
  readonly loadState: ThreadPanelLoadState | null;
  readonly membershipByThreadId: ReadonlyMap<string, string | null>;
  readonly moveTargets: readonly ThreadMoveTarget[];
  readonly onDeleteThread: (threadId: string) => Promise<void>;
  readonly onMoveThreadToGroup: (threadId: string, groupId: string | null) => Promise<void>;
  readonly onRenameThread: (threadId: string, title: string) => Promise<void>;
  readonly onSelectThread: (threadId: string) => void;
  readonly onUpdateThreadMetadata: (
    threadId: string,
    metadata: AssistantThreadMetadata
  ) => Promise<void>;
  readonly repository: AssistantThreadRepository | null;
  readonly selectedThreadId: string | undefined;
  readonly threads: readonly AssistantMemoryThread[];
  readonly view: ThreadListView;
}): ReactElement {
  if (!repository && databaseStartupLoading) {
    return (
      <ThreadStateCard
        description="Reading Mastra memory from PGlite."
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
  if (threads.length === 0 && view.kind === 'flat') {
    return (
      <ThreadStateCard
        description="Create a new Mastra memory thread for this workspace."
        testId="threads-placeholder-card"
        title="No threads found"
      />
    );
  }
  const rowsProps = {
    membershipByThreadId,
    moveTargets,
    onDeleteThread,
    onMoveThreadToGroup,
    onRenameThread,
    onSelectThread,
    onUpdateThreadMetadata,
    selectedThreadId,
  };
  if (view.kind === 'flat') {
    return <ThreadRows {...rowsProps} threads={view.threads} />;
  }
  return (
    <div className="space-y-3">
      {view.sections.map((section) => {
        const isCollapsed = Boolean(groupHandlers.collapsedGroupIds[section.group.id]);
        const isRenaming = groupHandlers.renamingGroupId === section.group.id;
        return (
          <div data-testid="thread-group-section" key={section.group.id}>
            <GroupHeaderDndShell groupId={section.group.id}>
              <ThreadGroupHeader
                collapsed={isCollapsed}
                group={section.group}
                onDeleteGroup={() => groupHandlers.onDeleteGroup(section.group.id)}
                onRenameGroupStart={() => groupHandlers.onGroupRenameStart(section.group)}
                onToggleCollapsed={() => groupHandlers.onToggleGroupCollapsed(section.group.id)}
                renameForm={
                  isRenaming ? (
                    <ThreadGroupRenameForm
                      draftName={groupHandlers.renamingGroupDraftName}
                      onCancel={groupHandlers.onGroupRenameCancel}
                      onDraftNameChange={groupHandlers.onGroupRenameDraftChange}
                      onSubmit={groupHandlers.onGroupRenameSubmit}
                      saving={groupHandlers.savingGroupId === section.group.id}
                    />
                  ) : null
                }
                threadCount={section.threads.length}
              />
            </GroupHeaderDndShell>
            {isCollapsed ? null : (
              <GroupBodyDndShell groupId={section.group.id}>
                <div className="mt-1 pl-2">
                  {section.threads.length > 0 ? (
                    <ThreadRows {...rowsProps} threads={section.threads} />
                  ) : (
                    <div className="rounded-md border border-border border-dashed px-3 py-2 text-[11px] text-muted-foreground">
                      Drop threads here
                    </div>
                  )}
                </div>
              </GroupBodyDndShell>
            )}
          </div>
        );
      })}
      <div data-testid="threads-ungrouped-section">
        <UngroupedSectionDndShell>
          <div className="flex min-h-8 items-center gap-1.5 px-1">
            <span className="font-medium text-muted-foreground text-xs">Ungrouped</span>
            <span
              className="rounded-full border border-border bg-background px-1.5 text-[10px] text-muted-foreground"
              data-testid="threads-ungrouped-count"
            >
              {view.ungrouped.length}
            </span>
          </div>
          <div className="mt-1">
            {view.ungrouped.length > 0 ? (
              <ThreadRows {...rowsProps} threads={view.ungrouped} />
            ) : (
              <div className="rounded-md border border-border border-dashed px-3 py-2 text-[11px] text-muted-foreground">
                Drop threads here to ungroup them
              </div>
            )}
          </div>
        </UngroupedSectionDndShell>
      </div>
    </div>
  );
}

export function ThreadsPanel(): ReactElement {
  const database = usePGliteDatabase();
  const databaseInitializing = useDbInitializing();
  const databaseStatus = useDbInitializationStatus();
  const databaseError = useDbProviderError();
  // Assistant memory is workspace-global: one stable resource id, never the
  // focused root path. Keying on the focused root wiped threads on focus change
  // (e.g. adding a folder) and gated the assistant behind "open a folder first".
  // See assistant-memory-resource.ts.
  const resourceId = WORKSPACE_MEMORY_RESOURCE_ID;
  const repository = useMemo(
    () => (database ? createPgliteAssistantThreadRepository(database) : null),
    [database]
  );
  const groupsRepository = useMemo(
    () => (database ? createPgliteAssistantThreadGroupsRepository(database) : null),
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
  const threads = threadsByResourceId[resourceId] ?? EMPTY_THREADS;
  const loadState = loadStateByResourceId[resourceId] ?? { status: 'idle' };
  const groupsByResourceId = useAssistantThreadGroupsStore((state) => state.groupsByResourceId);
  const placementsByThreadId = useAssistantThreadGroupsStore((state) => state.placementsByThreadId);
  const groupsLoadStateByResourceId = useAssistantThreadGroupsStore(
    (state) => state.loadStateByResourceId
  );
  const collapsedGroupIds = useAssistantThreadGroupsStore((state) => state.collapsedGroupIds);
  const groupBy = useAssistantThreadGroupsStore((state) => state.groupBy);
  const flatSortBy = useAssistantThreadGroupsStore((state) => state.flatSortBy);
  const groupedSortBy = useAssistantThreadGroupsStore((state) => state.groupedSortBy);
  const setGroupBy = useAssistantThreadGroupsStore((state) => state.setGroupBy);
  const setSortBy = useAssistantThreadGroupsStore((state) => state.setSortBy);
  const toggleGroupCollapsed = useAssistantThreadGroupsStore((state) => state.toggleGroupCollapsed);
  const ensureGroups = useAssistantThreadGroupsStore((state) => state.ensureGroups);
  const createGroup = useAssistantThreadGroupsStore((state) => state.createGroup);
  const renameGroup = useAssistantThreadGroupsStore((state) => state.renameGroup);
  const deleteGroup = useAssistantThreadGroupsStore((state) => state.deleteGroup);
  const reorderGroups = useAssistantThreadGroupsStore((state) => state.reorderGroups);
  const moveThreadToGroup = useAssistantThreadGroupsStore((state) => state.moveThreadToGroup);
  const applyThreadOrder = useAssistantThreadGroupsStore((state) => state.applyThreadOrder);
  const removeThreadPlacement = useAssistantThreadGroupsStore(
    (state) => state.removeThreadPlacement
  );
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renamingGroupDraftName, setRenamingGroupDraftName] = useState('');
  const [savingGroupId, setSavingGroupId] = useState<string | null>(null);
  const [groupActionError, setGroupActionError] = useState<string | null>(null);

  const groups = useMemo(
    () => groupsByResourceId[resourceId] ?? [],
    [groupsByResourceId, resourceId]
  );
  const groupsLoadState = groupsLoadStateByResourceId[resourceId] ?? { status: 'idle' };
  const placements = useMemo(
    () =>
      Object.values(placementsByThreadId).filter(
        (placement) => placement.resourceId === resourceId
      ),
    [placementsByThreadId, resourceId]
  );
  const membershipByThreadId = useMemo(
    () => buildThreadMembership({ groups, placements, threads }),
    [groups, placements, threads]
  );
  const sortPresentation = groupBy === 'none' ? 'flat' : 'grouped';
  const sortBy = sortPresentation === 'flat' ? flatSortBy : groupedSortBy;
  const view = useMemo(
    () => buildThreadListSections({ groupBy, groups, placements, sortBy, threads }),
    [groupBy, groups, placements, sortBy, threads]
  );
  const moveTargets = useMemo(
    () => groups.map((group) => ({ id: group.id, name: group.name })),
    [groups]
  );

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
    // The placement row is inert once the thread is gone; clear it so the
    // placements table does not accumulate orphans.
    if (groupsRepository && placementsByThreadId[threadId]) {
      await removeThreadPlacement(groupsRepository, threadId);
    }
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
  const handleMoveThreadToGroup = useCallback(
    async (threadId: string, groupId: string | null): Promise<void> => {
      if (!groupsRepository) {
        return;
      }
      setGroupActionError(null);
      await moveThreadToGroup(groupsRepository, resourceId, threadId, groupId);
    },
    [groupsRepository, moveThreadToGroup, resourceId]
  );
  const handleCreateGroup = (): void => {
    if (!groupsRepository) {
      return;
    }
    setGroupActionError(null);
    createGroup(groupsRepository, resourceId, 'New group')
      .then((group) => {
        setRenamingGroupId(group.id);
        setRenamingGroupDraftName(group.name);
      })
      .catch((error: unknown) => {
        setGroupActionError(error instanceof Error ? error.message : String(error));
      });
  };
  const handleGroupRenameSubmit = (): void => {
    if (!(groupsRepository && renamingGroupId)) {
      return;
    }
    setSavingGroupId(renamingGroupId);
    setGroupActionError(null);
    renameGroup(groupsRepository, resourceId, renamingGroupId, renamingGroupDraftName)
      .then(() => {
        setRenamingGroupId(null);
        setRenamingGroupDraftName('');
      })
      .catch((error: unknown) => {
        setGroupActionError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setSavingGroupId(null);
      });
  };
  const handleDeleteGroup = (groupId: string): void => {
    if (!groupsRepository) {
      return;
    }
    setGroupActionError(null);
    deleteGroup(groupsRepository, resourceId, groupId).catch((error: unknown) => {
      setGroupActionError(error instanceof Error ? error.message : String(error));
    });
  };
  const handlePanelDrop = useCallback(
    (source: ThreadsPanelDragSource, target: ThreadsPanelDropTarget): void => {
      if (!groupsRepository) {
        return;
      }
      const intent = resolveThreadsPanelDrop({
        groupIdByThreadId: membershipByThreadId,
        source,
        target,
        view,
      });
      if (intent.kind === 'none') {
        return;
      }
      setGroupActionError(null);
      const run =
        intent.kind === 'move-thread-to-group'
          ? moveThreadToGroup(groupsRepository, resourceId, intent.threadId, intent.groupId)
          : intent.kind === 'apply-thread-order'
            ? applyThreadOrder(
                groupsRepository,
                resourceId,
                intent.presentation,
                intent.orderedEntries
              )
            : reorderGroups(groupsRepository, resourceId, intent.orderedGroupIds);
      run.catch((error: unknown) => {
        setGroupActionError(error instanceof Error ? error.message : String(error));
      });
    },
    [
      applyThreadOrder,
      groupsRepository,
      membershipByThreadId,
      moveThreadToGroup,
      reorderGroups,
      resourceId,
      view,
    ]
  );
  useThreadsPanelDropMonitor(handlePanelDrop);

  useEffect(() => {
    if (!(repository && resourceId)) {
      return;
    }
    ensureResourceThreads(repository, resourceId).catch(() => {
      // The store records the explicit error state; no fallback thread source is used.
    });
  }, [ensureResourceThreads, repository, resourceId]);

  useEffect(() => {
    if (!(groupsRepository && resourceId)) {
      return;
    }
    ensureGroups(groupsRepository, resourceId).catch(() => {
      // The groups store records the explicit error state; the panel surfaces it.
    });
  }, [ensureGroups, groupsRepository, resourceId]);

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
        <div className="flex shrink-0 items-center gap-1">
          <ThreadsViewOptionsPopover
            groupBy={groupBy}
            onGroupByChange={setGroupBy}
            onSortByChange={(nextSortBy) => setSortBy(sortPresentation, nextSortBy)}
            sortBy={sortBy}
          />
          <Button
            aria-label="New group"
            className="h-8 w-8 p-0"
            disabled={!groupsRepository}
            onClick={handleCreateGroup}
            size="sm"
            title="New group"
            type="button"
            variant="ghost"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </Button>
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
      </div>

      {groupActionError ? (
        <p
          className="px-3 pb-2 text-[11px] text-destructive"
          data-testid="thread-groups-action-error"
        >
          {groupActionError}
        </p>
      ) : null}
      {groupsLoadState.status === 'error' ? (
        <p
          className="px-3 pb-2 text-[11px] text-destructive"
          data-testid="thread-groups-error-card"
        >
          Failed to load thread groups: {groupsLoadState.error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <ThreadsPanelContent
          databaseError={databaseError}
          databaseStartupLoading={databaseStartupLoading}
          groupHandlers={{
            collapsedGroupIds,
            onDeleteGroup: handleDeleteGroup,
            onGroupRenameCancel: () => {
              setRenamingGroupId(null);
              setRenamingGroupDraftName('');
            },
            onGroupRenameDraftChange: setRenamingGroupDraftName,
            onGroupRenameStart: (group: AssistantThreadGroup) => {
              setRenamingGroupId(group.id);
              setRenamingGroupDraftName(group.name);
            },
            onGroupRenameSubmit: handleGroupRenameSubmit,
            onToggleGroupCollapsed: toggleGroupCollapsed,
            renamingGroupDraftName,
            renamingGroupId,
            savingGroupId,
          }}
          loadState={loadState}
          membershipByThreadId={membershipByThreadId}
          moveTargets={moveTargets}
          onDeleteThread={handleDeleteThread}
          onMoveThreadToGroup={handleMoveThreadToGroup}
          onRenameThread={handleRenameThread}
          onSelectThread={handleSelectThread}
          onUpdateThreadMetadata={handleUpdateThreadMetadata}
          repository={repository}
          selectedThreadId={selectedThreadId}
          threads={threads}
          view={view}
        />
      </div>
    </section>
  );
}
