import { useEnsureModelRegistry } from '@brainstrike/app-state/hooks/use-model-registry';
import { isRetiredModelId } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { isSupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import {
  ASSISTANT_THREAD_COLOR_IDS,
  ASSISTANT_THREAD_ICON_IDS,
  type AssistantMemoryThread,
  type AssistantThreadColorId,
  type AssistantThreadGroup,
  type AssistantThreadIconId,
  type AssistantThreadMetadata,
  type AssistantThreadRepository,
  buildThreadListSections,
  buildThreadMembership,
  createPgliteAssistantThreadGroupsRepository,
  createPgliteAssistantThreadRepository,
  getGroupMemberIds,
  getThreadPrimaryRootId,
  type ThreadFilters,
  type ThreadFolderRow,
  type ThreadListView,
  type ThreadOrderPresentation,
  type ThreadsPanelFolderSortBy,
  type ThreadsPanelGroupBy,
  type ThreadsPanelSortBy,
  useAssistantThreadGroupsStore,
  useAssistantThreadStore,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import {
  type AnyContextAction,
  defineContextAction,
  type TargetOf,
} from '@brainstrike/context-actions';
import { ThreadSearchRepository } from '@brainstrike/db';
import {
  useDbInitializationStatus,
  useDbInitializing,
  useDbProviderError,
  usePGliteDatabase,
} from '@brainstrike/db/react';
import { buildLocalEmbeddingModelConfigMap } from '@brainstrike/db-explorer/embedding-models';
import type { QueueAdapter } from '@brainstrike/queue';
import type { ForgePrCacheEntry } from '@brainstrike/types';
import {
  ActionContextMenu,
  Button,
  type CheckboxState,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SelectionActionBar,
  SelectionActionBarOverlay,
  type TreeNode,
  TreeTable,
  type TreeTableColumn,
  useContextMenuTarget,
} from '@brainstrike/ui';
import { useSharedSearchEmbedder } from '@brainstrike/vector-management';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Folder,
  FolderMinus,
  FolderPlus,
  GitBranch,
  GitPullRequest,
  ListChecks,
  MessageSquare,
  MoreHorizontal,
  Palette,
  Pencil,
  Plus,
  SwatchBook,
  Trash2,
  X,
} from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { assistantThreadToTarget } from './assistant-thread-context-actions';
import { shouldRenderAssistantThreadDatabaseStartupLoading } from './assistant-thread-database-state';
import {
  ASSISTANT_THREAD_COLOR_PRESENTATION,
  ASSISTANT_THREAD_ICON_PRESENTATION,
  getAssistantThreadColorSurface,
  resolveThreadRowStatusState,
  THREAD_CONTROL_ACTION_CLASS_NAME,
  THREAD_CONTROL_MARK_CLASS_NAME,
  THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME,
  THREAD_CONTROL_TITLE_CLASS_NAME,
  type ThreadRowStatusState,
} from './assistant-thread-presentation';
import { useCreateThreadInFolder } from './hooks/use-create-thread-in-folder';
import { type ForgePrCacheLookup, useForgePrCache } from './hooks/use-forge-pr-cache';
import type { ThreadBranchInfo } from './hooks/use-thread-branch-by-root-path';
import { useThreadBranchByRootPath } from './hooks/use-thread-branch-by-root-path';
import { useThreadFolderRows } from './hooks/use-thread-folder-rows';
import { useThreadsAwaitingApproval } from './hooks/use-threads-awaiting-approval';
import { useMarkActiveThreadViewed, useUnseenThreadIds } from './hooks/use-unseen-thread-ids';
import { lookupThreadBranch, type ThreadBranchLookup } from './thread-branch-resolution';
import { ThreadFolderHeader } from './thread-folder-header';
import { lookupThreadForgePr } from './thread-forge-pr-resolution';
import {
  filterThreadsByThreadFilters,
  hasActiveThreadFilters,
  resolveThreadPanelContentState,
  type ThreadPanelFolderGroupingState,
  type ThreadPanelLoadState,
} from './thread-panel-content-state';
import {
  getThreadPanelCollapseId,
  getThreadPanelMemberSectionId,
  getThreadPanelRowHeightPx,
  THREAD_PANEL_DISCLOSURE_INCREMENT,
  type ThreadPanelGroupRow,
  type ThreadPanelVisibleRow,
} from './thread-panel-visible-rows';
import { ThreadRowStatusGlyph } from './thread-row-status-glyph';
import { useThreadSearchStore } from './thread-search-store';
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
import { ThreadsPanelSearch } from './threads-panel-search';
import { ThreadsViewOptionsPopover } from './threads-panel-view-options';
import { useActiveAssistantThreadIds } from './use-active-assistant-thread-ids';
import { type ThreadPanelSelection, useThreadPanelSelection } from './use-thread-panel-selection';
import { useThreadSearchController } from './use-thread-search-controller';

// Stable fallback so `threads` keeps referential identity across renders when
// the resource has no entry yet (the membership/view useMemos depend on it).
const EMPTY_THREADS: readonly AssistantMemoryThread[] = [];
// Stable identities so folder mode's empty inputs do not churn memo deps.
const EMPTY_MOVE_TARGETS: readonly ThreadMoveTarget[] = [];
const EMPTY_ROOT_IDS: readonly string[] = [];

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

function getThreadIconId(thread: AssistantMemoryThread): AssistantThreadIconId {
  return thread.metadata?.icon ?? 'message';
}

function getThreadColorId(thread: AssistantMemoryThread): AssistantThreadColorId | null {
  return thread.metadata?.color ?? null;
}

function getThreadColorConfig(thread: AssistantMemoryThread) {
  return getAssistantThreadColorSurface(getThreadColorId(thread));
}

function getReasoningValue(thread: AssistantMemoryThread): string | null {
  const provider = thread.latestRun?.provider;
  const providerOptions = thread.latestRun?.providerOptions;
  const providerRecord =
    provider && providerOptions && typeof providerOptions[provider] === 'object'
      ? (providerOptions[provider] as Record<string, unknown>)
      : null;
  const nestedReasoning = providerRecord?.['reasoning'];
  const nestedEffort =
    nestedReasoning && typeof nestedReasoning === 'object'
      ? (nestedReasoning as Record<string, unknown>)['effort']
      : undefined;
  const reasoning =
    providerRecord?.['reasoningEffort'] ?? providerRecord?.['effort'] ?? nestedEffort;
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

function getThreadModelLabel(thread: AssistantMemoryThread): string | null {
  const model = thread.latestRun?.model;
  if (!model) {
    return null;
  }
  const provider = thread.latestRun?.provider;
  return (provider !== undefined && !isSupportedProvider(provider)) ||
    isRetiredModelId(provider, model)
    ? `Unavailable · ${model}`
    : model;
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
  activeThreadIds,
  branchLookup,
  failedUnseenThreadIds,
  folderMode,
  forgePrLookup,
  membershipByThreadId,
  moveTargets,
  needsYouThreadIds,
  onDeleteThread,
  onMoveThreadToGroup,
  onRenameThread,
  onSelectThread,
  onUpdateThreadMetadata,
  rowsDraggable,
  selectedThreadId,
  threads,
  unseenThreadIds,
}: {
  readonly activeThreadIds: ReadonlySet<string>;
  /** Both branch joins — see {@link resolveThreadBranch}. */
  readonly branchLookup: ThreadBranchLookup;
  readonly failedUnseenThreadIds: ReadonlySet<string>;
  /**
   * Folder grouping: a folder section is a view over the thread's own root
   * binding, not a container it can be dragged into. Rows lose the drag shell
   * and the group-membership actions with it.
   */
  readonly folderMode: boolean;
  readonly forgePrLookup: ForgePrCacheLookup;
  readonly membershipByThreadId: ReadonlyMap<string, string | null>;
  readonly moveTargets: readonly ThreadMoveTarget[];
  readonly needsYouThreadIds: ReadonlySet<string>;
  readonly onDeleteThread: (threadId: string) => Promise<void>;
  readonly onMoveThreadToGroup: (threadId: string, groupId: string | null) => Promise<void>;
  readonly onRenameThread: (threadId: string, title: string) => Promise<void>;
  readonly onSelectThread: (threadId: string) => void;
  readonly onUpdateThreadMetadata: (
    threadId: string,
    metadata: AssistantThreadMetadata
  ) => Promise<void>;
  /**
   * False in folder grouping AND while a "Show only" filter narrows the list —
   * see {@link ThreadRowDragScope} for why both withdraw the affordance.
   */
  readonly rowsDraggable: boolean;
  readonly selectedThreadId: string | undefined;
  readonly threads: readonly AssistantMemoryThread[];
  readonly unseenThreadIds: ReadonlySet<string>;
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
        <ThreadRowDragScope
          draggable={rowsDraggable}
          groupId={folderMode ? null : (membershipByThreadId.get(thread.id) ?? null)}
          key={thread.id}
          threadId={thread.id}
        >
          <ThreadRowItem
            branch={resolveThreadBranch(thread, branchLookup)}
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
            pr={lookupThreadForgePr(thread, branchLookup, forgePrLookup)}
            renameError={renameError}
            rowGroupId={folderMode ? null : (membershipByThreadId.get(thread.id) ?? null)}
            savingMetadataThreadId={savingMetadataThreadId}
            savingThreadId={savingThreadId}
            selectedThreadId={selectedThreadId}
            status={resolveThreadRowStatusState({
              failedUnseen: failedUnseenThreadIds.has(thread.id),
              needsYou: needsYouThreadIds.has(thread.id),
              running: activeThreadIds.has(thread.id),
              unseen: unseenThreadIds.has(thread.id),
            })}
            thread={thread}
          />
        </ThreadRowDragScope>
      ))}
    </div>
  );
}

/**
 * The row's drag source, or a layout-equivalent plain wrapper.
 *
 * TWO states render rows WITHOUT the drag shell rather than with a disabled
 * one: `draggable="true"` with no honored drop is an affordance that lies.
 *
 * 1. FOLDER GROUPING. A folder is not a container a thread can be dropped
 *    into — the binding is the thread's own `metadata.operatingRootId`.
 * 2. AN ACTIVE "Show only" FILTER. The rendered section is partial, and a
 *    positional drop rewrites the whole listed section's ranks in one fresh
 *    sequence, so reordering under a filter would interleave the visible
 *    threads with the hidden ones' untouched ranks — a scrambled manual order
 *    the user only discovers after clearing the filter. `Move to …` on the row
 *    stays available, so membership is still reachable while filtered.
 *
 * `resolveThreadsPanelDrop` mirrors both, because the drop monitor is global.
 */
function ThreadRowDragScope({
  children,
  draggable,
  groupId,
  threadId,
}: {
  readonly children: ReactNode;
  readonly draggable: boolean;
  readonly groupId: string | null;
  readonly threadId: string;
}): ReactElement {
  if (!draggable) {
    return <div className="relative">{children}</div>;
  }
  return (
    <ThreadRowDndShell groupId={groupId} threadId={threadId}>
      {children}
    </ThreadRowDndShell>
  );
}

/**
 * The branch of the folder this thread works in, or `null`.
 *
 * TWO JOINS, durable root id first then a legacy path fallback — both keyed
 * lookups are documented on `use-thread-branch-by-root-path.ts`, which owns the
 * projection.
 *
 * 1. ROOT ID. `byRootId` is keyed by DB `roots.id`, the same id space as
 *    `metadata.operatingRootId`, and holds only root ids owned unambiguously
 *    by ONE worktree. A present durable id is authoritative: if it has no
 *    match, the thread has no branch chip. Falling through to the display path
 *    would let a replacement root mounted at the same path borrow the old
 *    thread's branch.
 * 2. PATH. Legacy threads without a durable root id can still use their
 *    display-only path. The folder rows carry the RAW `roots.path` while
 *    `byRootPath` is keyed by the NORMALIZED path, so this join has to normalize — an
 *    un-normalized key matches nothing and the chip silently never appears.
 *    That normalization seam is trim + trailing-separator strip only.
 *    Normalization is not symlink resolution: `roots.path` keeps the
 *    MOUNTED path and git reports the REALPATH, so a root mounted through a
 *    symlink (`/var/...` vs `/private/var/...`) never matches by path.
 *    The durable id lookup above resolves that skew without guessing for a
 *    folder that holds several repositories.
 *
 * A resolved worktree with NEITHER a branch nor a detached HEAD is a BARE one:
 * `git worktree list --porcelain` emits `bare` with no `branch` and no
 * `detached` line, and the parsers start every record at
 * `{branch: null, detached: false}`. It is `null` here rather than a chip,
 * because there is no name to render and `detached` would be a lie — an empty
 * pill would otherwise hold the first badge slot the narrow-panel container
 * query protects, and `ThreadMetadataBadges`' `if (!(branch || …))` early
 * return would count it as content.
 */
function resolveThreadBranch(
  thread: AssistantMemoryThread,
  branchLookup: ThreadBranchLookup
): ThreadBranchInfo | null {
  const resolved = lookupThreadBranch(thread, branchLookup);
  if (!resolved) {
    return null;
  }
  return resolved.branch || resolved.detached ? resolved : null;
}

function ThreadRowItem({
  branch,
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
  pr,
  renameError,
  rowGroupId,
  savingMetadataThreadId,
  savingThreadId,
  selectedThreadId,
  status,
  thread,
}: {
  readonly branch: ThreadBranchInfo | null;
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
  readonly pr: ForgePrCacheEntry | null;
  readonly renameError: string | null;
  readonly rowGroupId: string | null;
  readonly savingMetadataThreadId: string | null;
  readonly savingThreadId: string | null;
  readonly selectedThreadId: string | undefined;
  readonly status: ThreadRowStatusState | null;
  readonly thread: AssistantMemoryThread;
}): ReactElement {
  const isSelected = selectedThreadId === thread.id;
  const isEditing = editingThreadId === thread.id;
  const isConfirmingDelete = confirmingDeleteThreadId === thread.id;
  const isCustomizing = customizingThreadId === thread.id;
  const isExpanded = expandedThreadIds.has(thread.id);
  const colorConfig = getThreadColorConfig(thread);
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
      className={`my-0.5 flex ${THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME} w-auto flex-col justify-center overflow-hidden rounded-md px-2 text-left transition-[background-color,box-shadow] motion-reduce:transition-none ${
        isSelected ? colorConfig.selectedClassName : colorConfig.idleClassName
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
          status={status}
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
              branch={branch}
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
              pr={pr}
              selected={isSelected}
              status={status}
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
  status,
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
  readonly status: ThreadRowStatusState | null;
  readonly thread: AssistantMemoryThread;
}): ReactElement {
  return (
    <form
      className={`flex ${THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME} items-center gap-2`}
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
      <ThreadIdentityMark status={status} thread={thread} />
      <input
        aria-label="Thread title"
        className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => {
          onDraftTitleChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.key !== 'Escape') {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          onCancelRename();
        }}
        value={draftTitle}
      />
      {renameError ? <span className="text-[11px] text-destructive">{renameError}</span> : null}
      <Button
        aria-label="Save thread title"
        className={THREAD_CONTROL_ACTION_CLASS_NAME}
        disabled={savingThreadId === thread.id}
        size="icon-xs"
        type="submit"
        variant="ghost"
      >
        <Check className="size-3" />
      </Button>
      <Button
        aria-label="Cancel rename"
        className={THREAD_CONTROL_ACTION_CLASS_NAME}
        onClick={onCancelRename}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <X className="size-3" />
      </Button>
    </form>
  );
}

function ThreadRowDisplay({
  branch,
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
  pr,
  selected,
  status,
  thread,
}: {
  readonly branch: ThreadBranchInfo | null;
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
  readonly pr: ForgePrCacheEntry | null;
  readonly selected: boolean;
  readonly status: ThreadRowStatusState | null;
  readonly thread: AssistantMemoryThread;
}): ReactElement {
  const [actionsOpen, setActionsOpen] = useState(false);

  const closeActions = (): void => {
    setActionsOpen(false);
  };

  return (
    <>
      <div className="flex min-w-0 items-center justify-between gap-1.5">
        <button
          aria-current={selected ? 'true' : undefined}
          className="min-w-0 flex-1 text-left"
          onClick={(event) => {
            event.stopPropagation();
            onSelectThread(thread.id);
          }}
          type="button"
        >
          <div className="grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-2">
            <div className={`flex ${THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME} items-center`}>
              <ThreadIdentityMark status={status} thread={thread} />
            </div>
            <div
              className={`flex ${THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME} min-w-0 items-center gap-1.5`}
            >
              <div className={THREAD_CONTROL_TITLE_CLASS_NAME}>{thread.title}</div>
              <ThreadMetadataBadges branch={branch} pr={pr} thread={thread} />
            </div>
          </div>
        </button>
        <div className="-mr-px flex shrink-0 items-center gap-0.5">
          <Button
            aria-label={`${expanded ? 'Hide' : 'Show'} thread details ${thread.title}`}
            className={THREAD_CONTROL_ACTION_CLASS_NAME}
            onClick={(event) => {
              event.stopPropagation();
              onExpandedThreadToggle();
            }}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </Button>
          <Popover
            onOpenChange={(open) => {
              setActionsOpen(open);
              if (open || !customizing) {
                return;
              }
              onCustomizeThreadToggle();
            }}
            open={actionsOpen || customizing}
          >
            <PopoverTrigger asChild>
              <Button
                aria-label={`Thread actions ${thread.title}`}
                className={THREAD_CONTROL_ACTION_CLASS_NAME}
                onClick={(event) => event.stopPropagation()}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <MoreHorizontal className="size-3" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className={
                customizing
                  ? 'w-64 max-w-[calc(var(--radix-popover-content-available-width)-0.5rem)] p-3'
                  : 'w-48 p-1.5'
              }
              collisionPadding={8}
              onClick={(event) => event.stopPropagation()}
            >
              {customizing ? (
                <ThreadCustomizationPanel
                  metadataError={metadataError}
                  metadataSaving={metadataSaving}
                  onMetadataError={onMetadataError}
                  onSavingMetadataThreadIdChange={onSavingMetadataThreadIdChange}
                  onUpdateThreadMetadata={onUpdateThreadMetadata}
                  thread={thread}
                />
              ) : (
                <div className="grid gap-0.5">
                  <Button
                    className="h-8 justify-start gap-2 px-2 text-xs"
                    onClick={onCustomizeThreadToggle}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <SwatchBook className="size-3.5" />
                    Customize
                  </Button>
                  <Button
                    className="h-8 justify-start gap-2 px-2 text-xs"
                    onClick={() => {
                      closeActions();
                      onRenameThreadStart();
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <Pencil className="size-3.5" />
                    Rename
                  </Button>
                  <Button
                    className="h-8 justify-start gap-2 px-2 text-destructive text-xs hover:text-destructive"
                    onClick={() => {
                      closeActions();
                      onDeleteThreadStart();
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 className="size-3.5" />
                    Delete…
                  </Button>
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {pendingDelete ? (
        <div className="mt-2 mb-2 rounded-md border border-destructive/30 bg-destructive/5 p-2">
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

function ThreadIdentityMark({
  status,
  thread,
}: {
  readonly status: ThreadRowStatusState | null;
  readonly thread: AssistantMemoryThread;
}): ReactElement {
  const iconId = getThreadIconId(thread);
  const colorId = getThreadColorId(thread);
  const Icon = ASSISTANT_THREAD_ICON_PRESENTATION[iconId].iconComponent;
  const colorConfig = getThreadColorConfig(thread);
  return (
    <span
      className={`relative ${THREAD_CONTROL_MARK_CLASS_NAME} ${colorConfig.markClassName}`}
      data-testid={`thread-color-${colorId ?? 'unassigned'}`}
    >
      <Icon className="size-3" data-testid={`thread-icon-${iconId}`} />
      <ThreadRowStatusGlyph state={status} title={thread.title} />
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
    <div className="grid gap-3" data-testid="thread-customization-panel">
      <div>
        <div className="font-medium text-xs">Thread appearance</div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">Choose an icon and accent.</p>
      </div>
      <div className="grid gap-3">
        <div>
          <div className="mb-1.5 text-[11px] text-muted-foreground">Icon</div>
          <div className="grid grid-cols-6 gap-1">
            {ASSISTANT_THREAD_ICON_IDS.map((iconId) => {
              const Icon = ASSISTANT_THREAD_ICON_PRESENTATION[iconId].iconComponent;
              const label = ASSISTANT_THREAD_ICON_PRESENTATION[iconId].label;
              const selected = getThreadIconId(thread) === iconId;
              return (
                <Button
                  aria-label={`Use ${label} icon`}
                  aria-pressed={selected}
                  className={
                    selected ? 'bg-accent shadow-inner ring-1 ring-border' : 'text-muted-foreground'
                  }
                  disabled={metadataSaving}
                  key={iconId}
                  onClick={() => {
                    saveMetadata({ icon: iconId });
                  }}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <Icon className="size-4" />
                </Button>
              );
            })}
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-[11px] text-muted-foreground">Color</div>
          <div className="grid grid-cols-6 gap-1">
            {ASSISTANT_THREAD_COLOR_IDS.map((colorId) => {
              const label = ASSISTANT_THREAD_COLOR_PRESENTATION[colorId].label;
              const selected = getThreadColorId(thread) === colorId;
              return (
                <Button
                  aria-label={`Use ${label} color`}
                  aria-pressed={selected}
                  className={selected ? 'bg-accent shadow-inner ring-1 ring-border' : undefined}
                  disabled={metadataSaving}
                  key={colorId}
                  onClick={() => {
                    saveMetadata({ color: colorId });
                  }}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <span
                    className={`size-4 rounded-full ring-1 ring-black/10 ${ASSISTANT_THREAD_COLOR_PRESENTATION[colorId].accentClassName}`}
                  />
                </Button>
              );
            })}
          </div>
        </div>
      </div>
      {metadataError ? <p className="text-[11px] text-destructive">{metadataError}</p> : null}
    </div>
  );
}

function ThreadExpandedDetails({
  thread,
}: {
  readonly thread: AssistantMemoryThread;
}): ReactElement {
  const providerLabel = getProviderLabel(thread.latestRun?.provider);
  const modelLabel = getThreadModelLabel(thread);
  const reasoningValue = getReasoningValue(thread);
  const maxOutputValue = getMaxOutputValue(thread);
  return (
    <div
      className="mt-2 mb-2 rounded-md border border-border bg-background/70 p-2"
      data-testid="thread-expanded-details"
    >
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
        {providerLabel ? <ThreadDetail label="Provider" value={providerLabel} /> : null}
        {modelLabel ? <ThreadDetail label="Model" value={modelLabel} /> : null}
        {thread.latestRun?.runtimeKind ? (
          <ThreadDetail label="Runtime" value={thread.latestRun.runtimeKind} />
        ) : null}
        {thread.latestRun?.status ? (
          <ThreadDetail label="Status" value={thread.latestRun.status} />
        ) : null}
        {reasoningValue ? <ThreadDetail label="Reasoning" value={reasoningValue} /> : null}
        {maxOutputValue ? <ThreadDetail label="Max output" value={maxOutputValue} /> : null}
        {thread.metadata?.operatingRootDisplayName ? (
          <ThreadDetail
            label="Folder"
            title={thread.metadata.operatingRootPath ?? undefined}
            value={thread.metadata.operatingRootDisplayName}
          />
        ) : null}
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
  title,
  value,
}: {
  readonly label: string;
  /** Hover text for a value the row truncates — the folder's full path. */
  readonly title?: string | undefined;
  readonly value: string;
}): ReactElement {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="truncate font-medium" title={title}>
        {value}
      </div>
    </div>
  );
}

const PR_ROLLUP_GLYPH: Readonly<Record<ForgePrCacheEntry['checksRollup'], string>> = {
  failing: '✗',
  none: '·',
  passing: '✓',
  pending: '◐',
};

function ThreadMetadataBadges({
  branch,
  pr,
  thread,
}: {
  /** Only ever set in folder grouping, and only on desktop. */
  readonly branch: ThreadBranchInfo | null;
  /** Only ever set in folder grouping, and only when the cache has a row. */
  readonly pr: ForgePrCacheEntry | null;
  readonly thread: AssistantMemoryThread;
}): ReactElement | null {
  const providerLabel = getProviderLabel(thread.latestRun?.provider);
  const modelLabel = getThreadModelLabel(thread);
  const reasoningLabel = getReasoningLabel(thread);
  const maxOutputLabel = getMaxOutputLabel(thread);
  if (!(branch || pr || providerLabel || modelLabel || reasoningLabel || maxOutputLabel)) {
    return null;
  }
  // Whether a badge the narrow band unconditionally protects (branch or PR)
  // is actually rendering. When neither is present, the provider badge takes
  // over that protected slot instead of also hiding until 560px — see the
  // `wideOnly` note on ThreadBadge.
  const protectedBadgePresent = Boolean(branch || pr);
  return (
    <div
      className="@[420px]/threads:flex hidden min-w-0 shrink items-center gap-1 overflow-hidden"
      data-testid="thread-metadata-badges"
    >
      {/* Branch first, then PR: in folder grouping these two are the row's most
          local facts, and they are always visible once the container clears
          420px — see the `wideOnly` note on ThreadBadge for the rest. */}
      {branch ? (
        <ThreadBadge icon={GitBranch}>{branch.detached ? 'detached' : branch.branch}</ThreadBadge>
      ) : null}
      {pr ? (
        <span
          className={`inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border/70 bg-background/70 px-1.5 py-0 text-[9px] leading-4 ${
            pr.state === 'open' ? 'text-muted-foreground' : 'text-muted-foreground/60'
          }`}
          data-checks={pr.checksRollup}
          data-state={pr.state}
          data-testid="thread-pr-pill"
          title={`Pull request #${pr.number} (${pr.state})`}
        >
          <GitPullRequest aria-hidden="true" className="size-2.5" />
          {`#${pr.number}`}
          <span aria-hidden="true">
            {pr.isDraft && pr.state === 'open' ? '◌' : PR_ROLLUP_GLYPH[pr.checksRollup]}
          </span>
        </span>
      ) : null}
      {providerLabel ? (
        <ThreadBadge wideOnly={protectedBadgePresent}>{providerLabel}</ThreadBadge>
      ) : null}
      {modelLabel ? <ThreadBadge wideOnly>{modelLabel}</ThreadBadge> : null}
      {reasoningLabel ? <ThreadBadge wideOnly>{reasoningLabel}</ThreadBadge> : null}
      {maxOutputLabel ? <ThreadBadge wideOnly>{maxOutputLabel}</ThreadBadge> : null}
    </div>
  );
}

/** Exported for the panel unit lane; production renders it through ThreadRowItem. */
export { ThreadMetadataBadges as ThreadMetadataBadgesForTest };

function ThreadBadge({
  children,
  icon: Icon,
  wideOnly,
}: {
  readonly children: ReactNode;
  readonly icon?: LucideIcon;
  /**
   * Hidden until the container clears 560px, INSTEAD of the 420px every other
   * badge in this row gets. Carried per-badge rather than as a positional
   * `nth-child` selector on the container: `nth-child` counts RENDERED
   * children, and branch/PR are both conditional, so a positional rule's
   * meaning shifted with whichever optional badges happened to render —
   * bumping its threshold once (`n+2` to `n+3`) only patched the case with
   * both branch and PR present, and on every row with NEITHER (every row
   * outside folder grouping, and every row on web) it kept a second badge
   * visible in the 420-560px band that previously stayed hidden there,
   * eating into the title's `min-w-0` truncation for rows that have nothing
   * to do with a PR at all. A class the badge carries itself is correct
   * regardless of what else in the row rendered.
   *
   * SPARINGLY conditional: only the provider badge ever passes a computed
   * value here (`protectedBadgePresent` — whether branch or PR rendered).
   * When neither did, provider is the row's first badge and takes over the
   * "always visible in the narrow band" slot branch/PR would otherwise hold
   * — exactly the pre-PR-pill `nth-child(n+2)` behavior, where badge #1 was
   * always shown regardless of what it was. Model/reasoning/max-output stay
   * unconditionally `wideOnly`: they are never the row's first badge, so
   * there is no protected slot for them to inherit.
   */
  readonly wideOnly?: boolean;
}): ReactElement {
  return (
    <span
      className={`${wideOnly ? '@[560px]/threads:inline-flex hidden' : 'inline-flex'} shrink-0 items-center gap-0.5 rounded-full border border-border/70 bg-background/70 px-1.5 py-0 text-[9px] text-muted-foreground leading-4`}
    >
      {Icon ? <Icon aria-hidden="true" className="size-2.5" /> : null}
      {children}
    </span>
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
        autoFocus
        className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-[13px] leading-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
  group,
  onColorChange,
  onDeleteGroup,
  onIconChange,
  onRenameGroupStart,
  renameForm,
  threadCount,
}: {
  readonly group: AssistantThreadGroup;
  readonly onColorChange: (color: AssistantThreadColorId | null) => void;
  readonly onDeleteGroup: () => void;
  readonly onIconChange: (icon: AssistantThreadIconId | null) => void;
  readonly onRenameGroupStart: () => void;
  readonly renameForm: ReactElement | null;
  readonly threadCount: number;
}): ReactElement {
  const [actionsOpen, setActionsOpen] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const colorConfig = getAssistantThreadColorSurface(group.color);
  const GroupIcon = group.icon
    ? ASSISTANT_THREAD_ICON_PRESENTATION[group.icon].iconComponent
    : Folder;
  return (
    <div className="min-w-0" data-testid="thread-group-header">
      <div className="group/thread-group flex min-h-10 min-w-0 items-center gap-2 px-2">
        <span
          className={`flex size-6 shrink-0 items-center justify-center rounded-md border ${colorConfig.markClassName}`}
          data-testid={`thread-group-color-${group.color ?? 'unassigned'}`}
        >
          <GroupIcon
            className="size-3.5"
            data-testid={`thread-group-icon-${group.icon ?? 'folder'}`}
          />
        </span>
        {renameForm ?? (
          <>
            <span className="min-w-0 flex-1 truncate font-medium text-[13px] leading-4">
              {group.name}
            </span>
            <span
              className="shrink-0 rounded-full border border-border bg-background px-1.5 text-[10px] text-muted-foreground"
              data-testid="thread-group-count"
            >
              {threadCount}
            </span>
            <Popover
              onOpenChange={(open) => {
                setActionsOpen(open);
                if (!open) {
                  setCustomizing(false);
                }
              }}
              open={actionsOpen || customizing}
            >
              <PopoverTrigger asChild>
                <Button
                  aria-label={`Group actions ${group.name}`}
                  onClick={(event) => event.stopPropagation()}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className={customizing ? 'w-64 p-3' : 'w-44 p-1.5'}
                collisionPadding={8}
                onClick={(event) => event.stopPropagation()}
              >
                {customizing ? (
                  <div className="grid gap-2.5">
                    <div className="flex items-center gap-1.5">
                      <Button
                        aria-label={`Back to group actions for ${group.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setCustomizing(false);
                        }}
                        size="icon-xs"
                        type="button"
                        variant="ghost"
                      >
                        <ArrowLeft className="size-3.5" />
                      </Button>
                      <div>
                        <div className="font-medium text-xs">Group appearance</div>
                        <p className="text-[10px] text-muted-foreground">
                          Choose an icon and accent.
                        </p>
                      </div>
                    </div>
                    <div>
                      <div className="mb-1 text-[11px] text-muted-foreground">Icon</div>
                      <div className="grid grid-cols-6 gap-1" data-testid="thread-group-icon-grid">
                        {ASSISTANT_THREAD_ICON_IDS.map((iconId) => {
                          const Icon = ASSISTANT_THREAD_ICON_PRESENTATION[iconId].iconComponent;
                          const label = ASSISTANT_THREAD_ICON_PRESENTATION[iconId].label;
                          return (
                            <Button
                              aria-label={`Use ${label} icon for ${group.name}`}
                              aria-pressed={group.icon === iconId}
                              className={
                                group.icon === iconId
                                  ? 'bg-accent shadow-inner ring-1 ring-border'
                                  : 'text-muted-foreground'
                              }
                              key={iconId}
                              onClick={(event) => {
                                event.stopPropagation();
                                onIconChange(iconId);
                              }}
                              size="icon-sm"
                              type="button"
                              variant="ghost"
                            >
                              <Icon className="size-4" />
                            </Button>
                          );
                        })}
                        <Button
                          aria-label={`Restore folder icon for ${group.name}`}
                          aria-pressed={group.icon === null}
                          className="col-span-6 h-7 justify-start gap-2 px-2 text-[11px] text-muted-foreground"
                          onClick={(event) => {
                            event.stopPropagation();
                            onIconChange(null);
                          }}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          <Folder className="size-3.5" />
                          Default folder
                        </Button>
                      </div>
                    </div>
                    <div className="text-[11px] text-muted-foreground">Color</div>
                    <div className="grid grid-cols-4 gap-1" data-testid="thread-group-color-grid">
                      {ASSISTANT_THREAD_COLOR_IDS.map((colorId) => (
                        <Button
                          aria-label={`Use ${ASSISTANT_THREAD_COLOR_PRESENTATION[colorId].label} color for ${group.name}`}
                          aria-pressed={group.color === colorId}
                          className={`justify-self-center ${
                            group.color === colorId
                              ? 'bg-accent shadow-inner ring-1 ring-border'
                              : ''
                          }`}
                          key={colorId}
                          onClick={(event) => {
                            event.stopPropagation();
                            onColorChange(colorId);
                          }}
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                        >
                          <span
                            aria-hidden="true"
                            className={`size-4 rounded-full ring-1 ring-black/10 ${ASSISTANT_THREAD_COLOR_PRESENTATION[colorId].accentClassName}`}
                          />
                        </Button>
                      ))}
                      <Button
                        aria-label={`Clear color for ${group.name}`}
                        aria-pressed={group.color === null}
                        className={`justify-self-center ${
                          group.color === null ? 'bg-accent shadow-inner ring-1 ring-border' : ''
                        }`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onColorChange(null);
                        }}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        <span
                          aria-hidden="true"
                          className="size-4 rounded-full border border-border bg-muted"
                        />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-0.5">
                    <Button
                      className="h-8 justify-start gap-2 px-2 text-xs"
                      onClick={(event) => {
                        event.stopPropagation();
                        setCustomizing(true);
                      }}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <SwatchBook className="size-3.5" />
                      Customize
                    </Button>
                    <Button
                      className="h-8 justify-start gap-2 px-2 text-xs"
                      onClick={(event) => {
                        event.stopPropagation();
                        setActionsOpen(false);
                        onRenameGroupStart();
                      }}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <Pencil className="size-3.5" />
                      Rename
                    </Button>
                    <Button
                      className="h-8 justify-start gap-2 px-2 text-destructive text-xs hover:text-destructive"
                      onClick={(event) => {
                        event.stopPropagation();
                        setActionsOpen(false);
                        setConfirmingDelete(true);
                      }}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 className="size-3.5" />
                      Delete…
                    </Button>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          </>
        )}
      </div>
      {confirmingDelete ? (
        <div className="mx-1 mb-1 rounded-lg border border-destructive/30 bg-destructive/5 p-2">
          <p className="text-[11px] text-destructive">Delete folder {group.name}?</p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Its threads return to Ungrouped.
          </p>
          <div className="mt-2 flex justify-end gap-1.5">
            <Button
              aria-label={`Cancel delete group ${group.name}`}
              onClick={(event) => {
                event.stopPropagation();
                setConfirmingDelete(false);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              aria-label={`Confirm delete group ${group.name}`}
              onClick={(event) => {
                event.stopPropagation();
                setConfirmingDelete(false);
                onDeleteGroup();
              }}
              size="sm"
              type="button"
              variant="destructive"
            >
              Delete folder
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface ThreadGroupSectionHandlers {
  readonly collapsedGroupIds: Record<string, true>;
  readonly onDeleteGroup: (groupId: string) => void;
  readonly onGroupColorChange: (groupId: string, color: AssistantThreadColorId | null) => void;
  readonly onGroupIconChange: (groupId: string, icon: AssistantThreadIconId | null) => void;
  readonly onGroupRenameCancel: () => void;
  readonly onGroupRenameDraftChange: (name: string) => void;
  readonly onGroupRenameStart: (group: AssistantThreadGroup) => void;
  readonly onGroupRenameSubmit: () => void;
  readonly onToggleGroupCollapsed: (groupId: string) => void;
  readonly renamingGroupDraftName: string;
  readonly renamingGroupId: string | null;
  readonly savingGroupId: string | null;
}

function buildThreadPanelTreeNodes(
  rows: readonly ThreadPanelVisibleRow[]
): TreeNode<ThreadPanelVisibleRow>[] {
  return rows.map((row) => ({
    data: row,
    depth: row.kind === 'group' ? 0 : row.parentId === null ? 0 : 1,
    // Disclosure is already applied by buildThreadPanelVisibleRows, but every
    // section header remains an expandable treegrid parent so aria-expanded
    // and the shared Left/Right keyboard contract expose a symmetric tree.
    hasChildren: row.kind === 'group',
    id: row.id,
    parentId: row.kind === 'group' ? null : row.parentId,
    type: `thread-panel-${row.kind}`,
  }));
}

type ThreadGroupChassisPosition = 'end' | 'middle' | 'single' | 'start';

interface ThreadGroupChassisPresentation {
  readonly color: AssistantThreadColorId;
  readonly position: ThreadGroupChassisPosition;
}

function getThreadPanelRowGroupId(row: ThreadPanelVisibleRow): string | null {
  if (row.kind === 'group') {
    // Only a CUSTOM group tints a chassis: folder sections have no color of
    // their own (a folder is not a curated object).
    return row.header.kind === 'group' ? row.header.group.id : null;
  }
  return row.groupId;
}

function buildThreadGroupChassisByRowId(
  rows: readonly ThreadPanelVisibleRow[],
  colorByGroupId: ReadonlyMap<string, AssistantThreadColorId>
): ReadonlyMap<string, ThreadGroupChassisPresentation> {
  const chassisByRowId = new Map<string, ThreadGroupChassisPresentation>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) {
      continue;
    }
    const groupId = getThreadPanelRowGroupId(row);
    if (!groupId) {
      continue;
    }
    const color = colorByGroupId.get(groupId);
    if (!color) {
      continue;
    }
    const previousRow = rows[index - 1];
    const nextRow = rows[index + 1];
    const startsGroup = !previousRow || getThreadPanelRowGroupId(previousRow) !== groupId;
    const endsGroup = !nextRow || getThreadPanelRowGroupId(nextRow) !== groupId;
    const position: ThreadGroupChassisPosition = startsGroup
      ? endsGroup
        ? 'single'
        : 'start'
      : endsGroup
        ? 'end'
        : 'middle';
    chassisByRowId.set(row.id, { color, position });
  }
  return chassisByRowId;
}

/** Accessible name of a section, whatever kind of section it is. */
function getThreadPanelSectionLabel(row: ThreadPanelGroupRow): string {
  switch (row.header.kind) {
    case 'group':
      return row.header.group.name;
    case 'folder':
      return row.header.folder.displayName;
    case 'unassigned':
      return 'No folder';
    default:
      return 'Ungrouped';
  }
}

function getSelectionState(
  memberIds: readonly string[],
  selectedThreadIds: ReadonlySet<string>
): CheckboxState {
  let selectedCount = 0;
  for (const threadId of memberIds) {
    if (selectedThreadIds.has(threadId)) {
      selectedCount += 1;
    }
  }
  if (selectedCount === 0) {
    return 'unchecked';
  }
  return selectedCount === memberIds.length ? 'checked' : 'indeterminate';
}

type ThreadRowsProps = Parameters<typeof ThreadRows>[0];

// Group surfaces are borderless tinted slabs; only the rounded caps vary by
// the row's position inside the visible chassis.
const THREAD_GROUP_SURFACE_POSITION_CLASS_NAMES = {
  end: '[&>td]:rounded-b-lg',
  middle: '',
  single: '[&>td]:rounded-lg',
  start: '[&>td]:rounded-t-lg',
} satisfies Record<ThreadGroupChassisPosition, string>;

function ThreadPanelContentLane({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div className="relative mx-1 min-w-0" data-testid="thread-panel-content-lane">
      {children}
    </div>
  );
}

function ThreadPanelShowMoreCell({
  onShowMore,
  row,
}: {
  readonly onShowMore: (sectionKey: string) => void;
  readonly row: Extract<ThreadPanelVisibleRow, { readonly kind: 'show-more' }>;
}): ReactElement {
  const disclosureCount = Math.min(THREAD_PANEL_DISCLOSURE_INCREMENT, row.remainingCount);
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 px-2 py-1">
      <Button
        aria-label={`Show ${disclosureCount} more threads`}
        className="h-7 px-2 text-xs"
        onClick={(event) => {
          event.stopPropagation();
          onShowMore(row.sectionKey);
        }}
        size="sm"
        type="button"
        variant="ghost"
      >
        Show {disclosureCount} more
      </Button>
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {row.remainingCount} remaining
      </span>
    </div>
  );
}

function ThreadPanelEmptyCell({
  row,
}: {
  readonly row: Extract<ThreadPanelVisibleRow, { readonly kind: 'empty' }>;
}): ReactElement {
  const hint = row.groupId ? 'Drop threads here' : 'Drop threads here to ungroup them';
  const content = (
    <div
      className="my-0.5 flex min-h-9 items-center rounded-md border border-border/45 border-dashed px-2 text-[11px] text-muted-foreground/80"
      data-testid="thread-panel-drop-zone"
    >
      {hint}
    </div>
  );
  if (row.groupId) {
    return <GroupBodyDndShell groupId={row.groupId}>{content}</GroupBodyDndShell>;
  }
  return <UngroupedSectionDndShell>{content}</UngroupedSectionDndShell>;
}

function ThreadPanelGroupCell({
  groupHandlers,
  onNewThreadInFolder,
  row,
}: {
  readonly groupHandlers: ThreadGroupSectionHandlers;
  readonly onNewThreadInFolder: ((folder: ThreadFolderRow) => void) | null;
  readonly row: ThreadPanelGroupRow;
}): ReactElement {
  const header = row.header;
  if (header.kind === 'folder' || header.kind === 'unassigned') {
    return (
      <div data-testid="thread-group-section">
        <ThreadFolderHeader
          folder={header.kind === 'folder' ? header.folder : null}
          onNewThreadHere={onNewThreadInFolder}
          threadCount={row.totalCount}
        />
      </div>
    );
  }
  if (header.kind === 'ungrouped') {
    return (
      <UngroupedSectionDndShell>
        <div
          className="flex min-h-10 items-center gap-2 px-2"
          data-testid="threads-ungrouped-section"
        >
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/55 text-muted-foreground"
            data-testid="threads-ungrouped-icon"
          >
            <Folder className="size-3.5" />
          </span>
          <span className="font-medium text-muted-foreground text-xs">Ungrouped</span>
          <span
            className="rounded-full border border-border bg-background px-1.5 text-[10px] text-muted-foreground"
            data-testid="threads-ungrouped-count"
          >
            {row.totalCount}
          </span>
        </div>
      </UngroupedSectionDndShell>
    );
  }

  const group = header.group;
  const isRenaming = groupHandlers.renamingGroupId === group.id;
  return (
    <div data-testid="thread-group-section">
      <GroupHeaderDndShell groupId={group.id}>
        <ThreadGroupHeader
          group={group}
          onColorChange={(color) => groupHandlers.onGroupColorChange(group.id, color)}
          onDeleteGroup={() => groupHandlers.onDeleteGroup(group.id)}
          onIconChange={(icon) => groupHandlers.onGroupIconChange(group.id, icon)}
          onRenameGroupStart={() => groupHandlers.onGroupRenameStart(group)}
          renameForm={
            isRenaming ? (
              <ThreadGroupRenameForm
                draftName={groupHandlers.renamingGroupDraftName}
                onCancel={groupHandlers.onGroupRenameCancel}
                onDraftNameChange={groupHandlers.onGroupRenameDraftChange}
                onSubmit={groupHandlers.onGroupRenameSubmit}
                saving={groupHandlers.savingGroupId === group.id}
              />
            ) : null
          }
          threadCount={row.totalCount}
        />
      </GroupHeaderDndShell>
    </div>
  );
}

function ThreadPanelCell({
  groupHandlers,
  onNewThreadInFolder,
  onShowMore,
  row,
  rowsProps,
}: {
  readonly groupHandlers: ThreadGroupSectionHandlers;
  readonly onNewThreadInFolder: ((folder: ThreadFolderRow) => void) | null;
  readonly onShowMore: (sectionKey: string) => void;
  readonly row: ThreadPanelVisibleRow;
  readonly rowsProps: Omit<ThreadRowsProps, 'threads'>;
}): ReactElement {
  let content: ReactElement;
  if (row.kind === 'thread') {
    content = <ThreadRows {...rowsProps} threads={[row.thread]} />;
  } else if (row.kind === 'show-more') {
    content = <ThreadPanelShowMoreCell onShowMore={onShowMore} row={row} />;
  } else if (row.kind === 'empty') {
    content = <ThreadPanelEmptyCell row={row} />;
  } else {
    content = (
      <ThreadPanelGroupCell
        groupHandlers={groupHandlers}
        onNewThreadInFolder={onNewThreadInFolder}
        row={row}
      />
    );
  }
  return <ThreadPanelContentLane>{content}</ThreadPanelContentLane>;
}

interface ThreadBulkSelectionController {
  readonly confirmingDelete: boolean;
  readonly error: string | null;
  readonly onCancelDelete: () => void;
  readonly onClear: () => void;
  readonly onColor: (color: AssistantThreadColorId) => void;
  readonly onDelete: () => void;
  readonly onMove: (groupId: string | null) => void;
  readonly onStartDelete: () => void;
  readonly onTogglePanel: (panel: 'color' | 'move') => void;
  readonly panel: 'color' | 'move' | null;
  readonly pending: boolean;
  readonly selectedCount: number;
}

function useThreadBulkSelectionController({
  onBulkColor,
  onBulkDelete,
  onBulkMove,
  onClearSelection,
  selectedThreadIds,
}: {
  readonly onBulkColor: (
    threadIds: readonly string[],
    color: AssistantThreadColorId
  ) => Promise<void>;
  readonly onBulkDelete: (threadIds: readonly string[]) => Promise<void>;
  readonly onBulkMove: (threadIds: readonly string[], groupId: string | null) => Promise<void>;
  readonly onClearSelection: () => void;
  readonly selectedThreadIds: ReadonlySet<string>;
}): ThreadBulkSelectionController {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [panel, setPanel] = useState<'color' | 'move' | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const runAction = useCallback(
    (action: (threadIds: readonly string[]) => Promise<void>): void => {
      const threadIds = [...selectedThreadIds];
      setPending(true);
      setError(null);
      action(threadIds)
        .then(() => {
          onClearSelection();
          setPanel(null);
          setConfirmingDelete(false);
        })
        .catch((actionError: unknown) => {
          setError(actionError instanceof Error ? actionError.message : String(actionError));
        })
        .finally(() => setPending(false));
    },
    [onClearSelection, selectedThreadIds]
  );

  return {
    confirmingDelete,
    error,
    onCancelDelete: () => setConfirmingDelete(false),
    onClear: () => {
      onClearSelection();
      setPanel(null);
      setConfirmingDelete(false);
      setError(null);
    },
    onColor: (color) => runAction((threadIds) => onBulkColor(threadIds, color)),
    onDelete: () => runAction(onBulkDelete),
    onMove: (groupId) => runAction((threadIds) => onBulkMove(threadIds, groupId)),
    onStartDelete: () => {
      setPanel(null);
      setConfirmingDelete(true);
    },
    onTogglePanel: (nextPanel) =>
      setPanel((currentPanel) => (currentPanel === nextPanel ? null : nextPanel)),
    panel,
    pending,
    selectedCount: selectedThreadIds.size,
  };
}

function ThreadBulkSelectionOverlay({
  canMove,
  controller,
  moveTargets,
}: {
  /**
   * False in folder grouping: custom-group membership is invisible there, so a
   * Move action would move threads with no feedback of any kind.
   */
  readonly canMove: boolean;
  readonly controller: ThreadBulkSelectionController;
  readonly moveTargets: readonly ThreadMoveTarget[];
}): ReactElement {
  return (
    <SelectionActionBarOverlay className="inset-x-3 grid gap-2">
      {controller.error ? (
        <p
          className="rounded-lg border border-destructive/30 bg-popover px-3 py-2 text-[11px] text-destructive shadow-md"
          role="alert"
        >
          {controller.error}
        </p>
      ) : null}
      {controller.panel === 'move' ? (
        <div className="pointer-events-auto ml-auto w-56 rounded-xl border border-border/80 bg-popover/95 p-2 shadow-lg backdrop-blur-sm">
          <div className="px-2 pb-1 text-[11px] text-muted-foreground">Move selected to</div>
          <div className="grid gap-0.5">
            {moveTargets.map((target) => (
              <Button
                className="h-8 justify-start gap-2 px-2 text-xs"
                disabled={controller.pending}
                key={target.id}
                onClick={() => controller.onMove(target.id)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <Folder className="size-3.5" />
                {target.name}
              </Button>
            ))}
            <Button
              className="h-8 justify-start gap-2 px-2 text-xs"
              disabled={controller.pending}
              onClick={() => controller.onMove(null)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <FolderMinus className="size-3.5" />
              Ungrouped
            </Button>
          </div>
        </div>
      ) : null}
      {controller.panel === 'color' ? (
        <div className="pointer-events-auto ml-auto w-56 rounded-xl border border-border/80 bg-popover/95 p-2 shadow-lg backdrop-blur-sm">
          <div className="px-2 pb-1 text-[11px] text-muted-foreground">Color selected</div>
          <div className="grid grid-cols-4 gap-1" data-testid="thread-bulk-color-grid">
            {ASSISTANT_THREAD_COLOR_IDS.map((colorId) => (
              <Button
                aria-label={`Use ${ASSISTANT_THREAD_COLOR_PRESENTATION[colorId].label} color for ${controller.selectedCount} threads`}
                className="justify-self-center"
                disabled={controller.pending}
                key={colorId}
                onClick={() => controller.onColor(colorId)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <span
                  aria-hidden="true"
                  className={`size-3.5 rounded-full ${ASSISTANT_THREAD_COLOR_PRESENTATION[colorId].accentClassName}`}
                />
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      <SelectionActionBar
        actions={
          controller.confirmingDelete
            ? [
                {
                  disabled: controller.pending,
                  id: 'cancel-delete',
                  label: 'Cancel',
                  onAction: controller.onCancelDelete,
                },
                {
                  destructive: true,
                  disabled: controller.pending,
                  id: 'confirm-delete',
                  label: 'Confirm delete',
                  onAction: controller.onDelete,
                },
              ]
            : [
                ...(canMove
                  ? [
                      {
                        disabled: controller.pending,
                        icon: <Folder className="size-3.5" />,
                        id: 'move',
                        label: 'Move',
                        onAction: () => controller.onTogglePanel('move'),
                      },
                    ]
                  : []),
                {
                  disabled: controller.pending,
                  icon: <Palette className="size-3.5" />,
                  id: 'color',
                  label: 'Color',
                  onAction: () => controller.onTogglePanel('color'),
                },
                {
                  destructive: true,
                  disabled: controller.pending,
                  icon: <Trash2 className="size-3.5" />,
                  id: 'delete',
                  label: 'Delete',
                  onAction: controller.onStartDelete,
                },
              ]
        }
        ariaLabel="Thread selection actions"
        className="pointer-events-auto order-last w-full"
        compact
        onClear={controller.onClear}
        summary={
          controller.confirmingDelete
            ? `Delete ${controller.selectedCount} selected threads?`
            : `${controller.selectedCount} selected`
        }
      />
    </SelectionActionBarOverlay>
  );
}

function ThreadPanelTree({
  activeThreadIds,
  branchLookup,
  failedUnseenThreadIds,
  forgePrLookup,
  groupHandlers,
  membershipByThreadId,
  moveTargets,
  needsYouThreadIds,
  onBulkColor,
  onBulkDelete,
  onBulkMove,
  onDeleteThread,
  onMoveThreadToGroup,
  onNewThreadInFolder,
  onRenameThread,
  onSelectThread,
  onUpdateThreadMetadata,
  selectedThreadId,
  selection,
  threadFiltersActive,
  unseenThreadIds,
  view,
}: {
  readonly activeThreadIds: ReadonlySet<string>;
  readonly branchLookup: ThreadBranchLookup;
  readonly failedUnseenThreadIds: ReadonlySet<string>;
  readonly forgePrLookup: ForgePrCacheLookup;
  readonly groupHandlers: ThreadGroupSectionHandlers;
  readonly membershipByThreadId: ReadonlyMap<string, string | null>;
  readonly moveTargets: readonly ThreadMoveTarget[];
  readonly needsYouThreadIds: ReadonlySet<string>;
  readonly onBulkColor: (
    threadIds: readonly string[],
    color: AssistantThreadColorId
  ) => Promise<void>;
  readonly onBulkDelete: (threadIds: readonly string[]) => Promise<void>;
  readonly onBulkMove: (threadIds: readonly string[], groupId: string | null) => Promise<void>;
  readonly onDeleteThread: (threadId: string) => Promise<void>;
  readonly onMoveThreadToGroup: (threadId: string, groupId: string | null) => Promise<void>;
  readonly onNewThreadInFolder: ((folder: ThreadFolderRow) => void) | null;
  readonly onRenameThread: (threadId: string, title: string) => Promise<void>;
  readonly onSelectThread: (threadId: string) => void;
  readonly onUpdateThreadMetadata: (
    threadId: string,
    metadata: AssistantThreadMetadata
  ) => Promise<void>;
  readonly selectedThreadId: string | undefined;
  readonly selection: ThreadPanelSelection;
  /** Withdraws the row drag affordance — see {@link ThreadRowDragScope}. */
  readonly threadFiltersActive: boolean;
  readonly unseenThreadIds: ReadonlySet<string>;
  readonly view: ThreadListView;
}): ReactElement {
  const folderMode = view.kind === 'folders';
  const {
    clearSelection,
    onShowMore: handleShowMore,
    replaceSelection,
    selectGroup,
    selectedThreadIds: selectedAvailableThreadIds,
    visibleRows,
  } = selection;
  const nodes = useMemo(() => buildThreadPanelTreeNodes(visibleRows.rows), [visibleRows.rows]);
  const colorByGroupId = useMemo(
    () =>
      new Map(
        view.kind === 'grouped'
          ? view.sections.flatMap((section) =>
              section.header.group.color
                ? ([[section.header.group.id, section.header.group.color]] as const)
                : ([] as const)
            )
          : []
      ),
    [view]
  );
  const groupChassisByRowId = useMemo(
    () => buildThreadGroupChassisByRowId(visibleRows.rows, colorByGroupId),
    [colorByGroupId, visibleRows.rows]
  );
  const expandedGroupIds = useMemo(
    () =>
      new Set(
        visibleRows.rows.flatMap((row) => (row.kind === 'group' && !row.collapsed ? [row.id] : []))
      ),
    [visibleRows.rows]
  );
  const bulkSelectionController = useThreadBulkSelectionController({
    onBulkColor,
    onBulkDelete,
    onBulkMove,
    onClearSelection: clearSelection,
    selectedThreadIds: selectedAvailableThreadIds,
  });

  const rowsProps = useMemo<Omit<ThreadRowsProps, 'threads'>>(
    () => ({
      activeThreadIds,
      branchLookup,
      failedUnseenThreadIds,
      folderMode,
      forgePrLookup,
      membershipByThreadId,
      // A folder is not a custom group, so folder mode offers no "Move to …"
      // row action: the binding is the thread's own, re-bound from the
      // composer's folder chip.
      moveTargets: folderMode ? EMPTY_MOVE_TARGETS : moveTargets,
      needsYouThreadIds,
      onDeleteThread,
      onMoveThreadToGroup,
      onRenameThread,
      onSelectThread,
      onUpdateThreadMetadata,
      rowsDraggable: !(folderMode || threadFiltersActive),
      selectedThreadId,
      unseenThreadIds,
    }),
    [
      activeThreadIds,
      branchLookup,
      failedUnseenThreadIds,
      folderMode,
      forgePrLookup,
      membershipByThreadId,
      moveTargets,
      needsYouThreadIds,
      onDeleteThread,
      onMoveThreadToGroup,
      onRenameThread,
      onSelectThread,
      onUpdateThreadMetadata,
      selectedThreadId,
      threadFiltersActive,
      unseenThreadIds,
    ]
  );
  const columns = useMemo<TreeTableColumn<ThreadPanelVisibleRow>[]>(
    () => [
      {
        cell: ({ node }) => (
          <ThreadPanelCell
            groupHandlers={groupHandlers}
            onNewThreadInFolder={onNewThreadInFolder}
            onShowMore={handleShowMore}
            row={node.data}
            rowsProps={rowsProps}
          />
        ),
        className: 'p-0',
        id: 'thread',
        indentWidth: 24,
        reserveCheckboxSpace: true,
        reserveToggleSpace: false,
        treeControlsPosition: 'top',
      },
    ],
    [groupHandlers, handleShowMore, onNewThreadInFolder, rowsProps]
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <TreeTable
        ariaLabel="Workspace threads"
        className="table-fixed border-separate border-spacing-0 outline-none"
        columns={columns}
        expandedIds={expandedGroupIds}
        getCheckboxAriaLabel={(node) => {
          const row = node.data;
          if (row.kind === 'thread') {
            return `Select thread ${row.thread.title}`;
          }
          if (row.kind === 'group') {
            return `Select all ${row.totalCount} threads in ${getThreadPanelSectionLabel(row)}`;
          }
          return;
        }}
        getCheckboxState={(node) => {
          const row = node.data;
          if (row.kind === 'thread') {
            return selectedAvailableThreadIds.has(row.id) ? 'checked' : 'unchecked';
          }
          if (row.kind === 'group' && row.totalCount > 0) {
            return getSelectionState(
              getGroupMemberIds(view, getThreadPanelMemberSectionId(row)),
              selectedAvailableThreadIds
            );
          }
          return 'hidden';
        }}
        maxHeight="none"
        multiSelectedIds={new Set(selectedAvailableThreadIds)}
        nodes={nodes}
        nodesArePreFlattened
        onCheckboxChange={(node, nextState) => {
          const row = node.data;
          if (row.kind === 'thread') {
            const nextIds = new Set(selectedAvailableThreadIds);
            if (nextState === 'checked') {
              nextIds.add(row.id);
            } else {
              nextIds.delete(row.id);
            }
            replaceSelection(nextIds);
            return;
          }
          if (row.kind === 'group') {
            selectGroup(getThreadPanelMemberSectionId(row), nextState);
          }
        }}
        onMultiSelectChange={replaceSelection}
        onToggleExpand={(nodeId) => {
          const row = visibleRows.rows.find((candidate) => candidate.id === nodeId);
          if (row?.kind !== 'group') {
            return;
          }
          groupHandlers.onToggleGroupCollapsed(getThreadPanelCollapseId(row));
        }}
        rowClassName={(node) => {
          const row = node.data;
          const chassis = groupChassisByRowId.get(row.id);
          if (chassis) {
            const threadClassName = row.kind === 'thread' ? 'group/thread-tree-row' : '';
            return `thread-group-surface ${threadClassName} border-0 bg-transparent ${ASSISTANT_THREAD_COLOR_PRESENTATION[chassis.color].groupSurfaceClassName} ${THREAD_GROUP_SURFACE_POSITION_CLASS_NAMES[chassis.position]}`;
          }
          if (row.kind === 'thread') {
            return 'group/thread-tree-row border-0 bg-transparent hover:bg-transparent';
          }
          return 'border-0 bg-transparent hover:bg-muted/20';
        }}
        rowHeight={(node) => getThreadPanelRowHeightPx(node.data.kind)}
        selectionMode="multi"
        selectOnRowClick={false}
        showCheckbox
        showHeader={false}
        viewportClassName={
          selectedAvailableThreadIds.size > 0
            ? 'overscroll-contain px-2 pb-20 pt-1'
            : 'overscroll-contain px-2 py-1'
        }
        windowingStrategy="virtual"
      />
      {selectedAvailableThreadIds.size > 0 ? (
        <ThreadBulkSelectionOverlay
          canMove={!folderMode}
          controller={bulkSelectionController}
          moveTargets={moveTargets}
        />
      ) : null}
    </div>
  );
}

/**
 * How the list is ordered, which is NOT the same question as how it is grouped:
 * `flat` and `grouped` are the two presentations that own a MANUAL order and
 * therefore a persisted `ThreadsPanelSortBy`, while `folder` sorts by its own
 * `folderSortBy` (name/recency only — a folder section has nowhere to persist a
 * drag). Exhaustive over ThreadsPanelGroupBy so a future group-by value fails
 * loudly here instead of silently landing on `'grouped'`.
 */
type ThreadPanelSortPresentation = ThreadOrderPresentation | 'folder';

function resolveSortPresentation(groupBy: ThreadsPanelGroupBy): ThreadPanelSortPresentation {
  switch (groupBy) {
    case 'none':
      return 'flat';
    case 'custom-groups':
      return 'grouped';
    case 'folder':
      return 'folder';
    default: {
      const exhaustive: never = groupBy;
      throw new Error(`Unknown thread group-by presentation: ${JSON.stringify(exhaustive)}.`);
    }
  }
}

function ThreadsPanelContent({
  activeThreadIds,
  branchLookup,
  databaseError,
  databaseStartupLoading,
  failedUnseenThreadIds,
  folderGrouping,
  forgePrLookup,
  groupHandlers,
  loadState,
  membershipByThreadId,
  moveTargets,
  needsYouThreadIds,
  onBulkColor,
  onBulkDelete,
  onBulkMove,
  onDeleteThread,
  onMoveThreadToGroup,
  onNewThreadInFolder,
  onRenameThread,
  onSelectThread,
  onUpdateThreadMetadata,
  repository,
  selectedThreadId,
  selection,
  threadFiltersActive,
  threads,
  unseenThreadIds,
  view,
}: {
  readonly activeThreadIds: ReadonlySet<string>;
  readonly branchLookup: ThreadBranchLookup;
  readonly databaseError: Error | null;
  readonly databaseStartupLoading: boolean;
  readonly failedUnseenThreadIds: ReadonlySet<string>;
  readonly folderGrouping: ThreadPanelFolderGroupingState | null;
  readonly forgePrLookup: ForgePrCacheLookup;
  readonly groupHandlers: ThreadGroupSectionHandlers;
  readonly loadState: ThreadPanelLoadState | null;
  readonly membershipByThreadId: ReadonlyMap<string, string | null>;
  readonly moveTargets: readonly ThreadMoveTarget[];
  readonly needsYouThreadIds: ReadonlySet<string>;
  readonly onBulkColor: (
    threadIds: readonly string[],
    color: AssistantThreadColorId
  ) => Promise<void>;
  readonly onBulkDelete: (threadIds: readonly string[]) => Promise<void>;
  readonly onBulkMove: (threadIds: readonly string[], groupId: string | null) => Promise<void>;
  readonly onDeleteThread: (threadId: string) => Promise<void>;
  readonly onMoveThreadToGroup: (threadId: string, groupId: string | null) => Promise<void>;
  readonly onNewThreadInFolder: ((folder: ThreadFolderRow) => void) | null;
  readonly onRenameThread: (threadId: string, title: string) => Promise<void>;
  readonly onSelectThread: (threadId: string) => void;
  readonly onUpdateThreadMetadata: (
    threadId: string,
    metadata: AssistantThreadMetadata
  ) => Promise<void>;
  readonly repository: AssistantThreadRepository | null;
  readonly selectedThreadId: string | undefined;
  readonly selection: ThreadPanelSelection;
  readonly threadFiltersActive: boolean;
  readonly threads: readonly AssistantMemoryThread[];
  readonly unseenThreadIds: ReadonlySet<string>;
  readonly view: ThreadListView;
}): ReactElement {
  const contentState = resolveThreadPanelContentState({
    databaseError,
    databaseStartupLoading,
    folderGrouping,
    loadState,
    repositoryReady: Boolean(repository),
    threadFiltersActive,
    threads,
    view,
  });
  if (contentState.kind === 'card') {
    return (
      <ThreadStateCard
        description={contentState.description}
        testId={contentState.testId}
        title={contentState.title}
        variant={contentState.variant}
      />
    );
  }
  return (
    <ThreadPanelTree
      activeThreadIds={activeThreadIds}
      branchLookup={branchLookup}
      failedUnseenThreadIds={failedUnseenThreadIds}
      forgePrLookup={forgePrLookup}
      groupHandlers={groupHandlers}
      membershipByThreadId={membershipByThreadId}
      moveTargets={moveTargets}
      needsYouThreadIds={needsYouThreadIds}
      onBulkColor={onBulkColor}
      onBulkDelete={onBulkDelete}
      onBulkMove={onBulkMove}
      onDeleteThread={onDeleteThread}
      onMoveThreadToGroup={onMoveThreadToGroup}
      onNewThreadInFolder={onNewThreadInFolder}
      onRenameThread={onRenameThread}
      onSelectThread={onSelectThread}
      onUpdateThreadMetadata={onUpdateThreadMetadata}
      selectedThreadId={selectedThreadId}
      selection={selection}
      threadFiltersActive={threadFiltersActive}
      unseenThreadIds={unseenThreadIds}
      view={view}
    />
  );
}

export interface ThreadsPanelProps {
  /**
   * Application embedding queue for the search feature's semantic arm (same
   * seam as ConnectedPromptManager). Absent = semantic search is visibly
   * unavailable; lexical search still works.
   */
  readonly loadEmbeddingQueue?: (() => Promise<QueueAdapter>) | null;
}

/**
 * Row one of the panel chrome: the heading, the live disclosed-thread count,
 * and every panel-level control.
 *
 * `treeOnScreen` gates the count and the select-visible toggle. Both describe
 * the treegrid, so when a state card or search results stand in for it they
 * withdraw rather than report a list that is not on screen.
 */
function ThreadsPanelToolbar({
  folderSortBy,
  groupBy,
  hasPrFilterAvailable,
  newGroupDisabled,
  newThreadDisabled,
  newThreadTitle,
  onClearThreadFilters,
  onCreateGroup,
  onCreateThread,
  onFolderSortByChange,
  onGroupByChange,
  onSortByChange,
  onThreadFilterChange,
  selection,
  sortBy,
  threadFilters,
  treeOnScreen,
}: {
  readonly folderSortBy: ThreadsPanelFolderSortBy;
  readonly groupBy: ThreadsPanelGroupBy;
  /** See `ThreadsViewOptionsPopover` — gates whether "Has PR" is offered at all. */
  readonly hasPrFilterAvailable: boolean;
  readonly newGroupDisabled: boolean;
  readonly newThreadDisabled: boolean;
  readonly newThreadTitle: string;
  readonly onClearThreadFilters: () => void;
  readonly onCreateGroup: () => void;
  readonly onCreateThread: () => void;
  readonly onFolderSortByChange: (folderSortBy: ThreadsPanelFolderSortBy) => void;
  readonly onGroupByChange: (groupBy: ThreadsPanelGroupBy) => void;
  readonly onSortByChange: (sortBy: ThreadsPanelSortBy) => void;
  readonly onThreadFilterChange: (filter: keyof ThreadFilters, enabled: boolean) => void;
  readonly selection: ThreadPanelSelection;
  readonly sortBy: ThreadsPanelSortBy;
  readonly threadFilters: ThreadFilters;
  readonly treeOnScreen: boolean;
}): ReactElement {
  const visibleThreadCount = selection.visibleRows.visibleThreadIds.length;
  // Two rows of chrome, not three: this row carries the live visible count and
  // the select-visible toggle that used to occupy a third band under the search
  // field. The old "Memory" pill and the "Workspace-scoped Mastra history"
  // subtitle both restated what the panel already is, so they are gone rather
  // than shrunk.
  //
  // pl-5, not px-3: the search field below is a bordered surface whose box edge
  // sits at 12px but whose first ink — the search icon — sits at 20px. Matching
  // the box edge left the heading looking 8px adrift of everything visible
  // under it, so the heading ink lines up with the icon instead.
  return (
    <div className="flex items-center gap-2 py-2 pr-3 pl-5" data-testid="threads-panel-toolbar">
      <h2 className="min-w-0 shrink-0 truncate font-medium text-sm leading-none">Threads</h2>
      {treeOnScreen ? (
        <span
          className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 font-medium text-[11px] text-muted-foreground tabular-nums leading-none"
          data-testid="threads-visible-count"
          title={`${visibleThreadCount} ${visibleThreadCount === 1 ? 'thread' : 'threads'} visible`}
        >
          {visibleThreadCount}
          <span className="sr-only">
            {visibleThreadCount === 1 ? ' thread visible' : ' threads visible'}
          </span>
        </span>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {treeOnScreen ? (
          <Button
            aria-label={`${selection.allVisibleSelected ? 'Clear' : 'Select'} ${visibleThreadCount} visible ${visibleThreadCount === 1 ? 'thread' : 'threads'}`}
            disabled={visibleThreadCount === 0}
            onClick={selection.toggleVisibleSelection}
            onKeyDown={(event) => {
              if (event.defaultPrevented || event.key !== 'Escape') {
                return;
              }
              event.preventDefault();
              selection.clearSelection();
            }}
            size="icon-xs"
            title={selection.allVisibleSelected ? 'Clear visible' : 'Select visible'}
            type="button"
            variant="ghost"
          >
            <ListChecks className="size-3.5" />
          </Button>
        ) : null}
        <ThreadsViewOptionsPopover
          folderSortBy={folderSortBy}
          groupBy={groupBy}
          hasPrFilterAvailable={hasPrFilterAvailable}
          onClearThreadFilters={onClearThreadFilters}
          onFolderSortByChange={onFolderSortByChange}
          onGroupByChange={onGroupByChange}
          onSortByChange={onSortByChange}
          onThreadFilterChange={onThreadFilterChange}
          sortBy={sortBy}
          threadFilters={threadFilters}
        />
        <Button
          aria-label="New group"
          disabled={newGroupDisabled}
          onClick={onCreateGroup}
          size="icon-xs"
          title="New group"
          type="button"
          variant="ghost"
        >
          <FolderPlus className="size-3.5" />
        </Button>
        <Button
          aria-label="New thread"
          // Icon-only, this is a 28px square exactly like its ghost
          // neighbours; it only grows into a labelled pill once the panel is
          // wide enough to show the label.
          className="ml-1 size-7 @[360px]/threads:w-auto @[360px]/threads:gap-1 @[360px]/threads:px-2 px-0 hover:bg-accent hover:text-accent-foreground"
          data-testid="new-agent-button"
          disabled={newThreadDisabled}
          onClick={onCreateThread}
          size="xs"
          title={newThreadTitle}
          type="button"
          variant="secondary"
        >
          <Plus className="size-3.5" />
          <span className="@[360px]/threads:inline hidden">New Thread</span>
        </Button>
      </div>
    </div>
  );
}

export function ThreadsPanel({ loadEmbeddingQueue = null }: ThreadsPanelProps = {}): ReactElement {
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
  const threadSearchRepository = useMemo(
    () => (database ? new ThreadSearchRepository(database) : null),
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
  const deleteThreads = useAssistantThreadStore((state) => state.deleteThreads);
  const renameThread = useAssistantThreadStore((state) => state.renameThread);
  const selectThread = useAssistantThreadStore((state) => state.selectThread);
  const updateThreadMetadata = useAssistantThreadStore((state) => state.updateThreadMetadata);
  const updateThreadsMetadata = useAssistantThreadStore((state) => state.updateThreadsMetadata);
  const selectedThreadId = selectedThreadByResourceId[resourceId];
  const threads = threadsByResourceId[resourceId] ?? EMPTY_THREADS;
  const loadState = loadStateByResourceId[resourceId] ?? { status: 'idle' };
  const activeThreads = useActiveAssistantThreadIds({
    database,
    resourceId,
    schemaReady: Object.hasOwn(threadsByResourceId, resourceId),
  });
  const groupsByResourceId = useAssistantThreadGroupsStore((state) => state.groupsByResourceId);
  const placementsByThreadId = useAssistantThreadGroupsStore((state) => state.placementsByThreadId);
  const groupsLoadStateByResourceId = useAssistantThreadGroupsStore(
    (state) => state.loadStateByResourceId
  );
  const collapsedGroupIds = useAssistantThreadGroupsStore((state) => state.collapsedGroupIds);
  const groupBy = useAssistantThreadGroupsStore((state) => state.groupBy);
  const flatSortBy = useAssistantThreadGroupsStore((state) => state.flatSortBy);
  const groupedSortBy = useAssistantThreadGroupsStore((state) => state.groupedSortBy);
  const folderSortBy = useAssistantThreadGroupsStore((state) => state.folderSortBy);
  const threadFilters = useAssistantThreadGroupsStore((state) => state.threadFilters);
  const setGroupBy = useAssistantThreadGroupsStore((state) => state.setGroupBy);
  const setSortBy = useAssistantThreadGroupsStore((state) => state.setSortBy);
  const setFolderSortBy = useAssistantThreadGroupsStore((state) => state.setFolderSortBy);
  const setThreadFilter = useAssistantThreadGroupsStore((state) => state.setThreadFilter);
  const clearThreadFilters = useAssistantThreadGroupsStore((state) => state.clearThreadFilters);
  const toggleGroupCollapsed = useAssistantThreadGroupsStore((state) => state.toggleGroupCollapsed);
  const ensureGroups = useAssistantThreadGroupsStore((state) => state.ensureGroups);
  const createGroup = useAssistantThreadGroupsStore((state) => state.createGroup);
  const renameGroup = useAssistantThreadGroupsStore((state) => state.renameGroup);
  const setGroupColor = useAssistantThreadGroupsStore((state) => state.setGroupColor);
  const setGroupIcon = useAssistantThreadGroupsStore((state) => state.setGroupIcon);
  const deleteGroup = useAssistantThreadGroupsStore((state) => state.deleteGroup);
  const reorderGroups = useAssistantThreadGroupsStore((state) => state.reorderGroups);
  const moveThreadToGroup = useAssistantThreadGroupsStore((state) => state.moveThreadToGroup);
  const moveThreadsToGroup = useAssistantThreadGroupsStore((state) => state.moveThreadsToGroup);
  const applyThreadOrder = useAssistantThreadGroupsStore((state) => state.applyThreadOrder);
  const removeThreadPlacement = useAssistantThreadGroupsStore(
    (state) => state.removeThreadPlacement
  );
  const pruneDeletedThreadPlacements = useAssistantThreadGroupsStore(
    (state) => state.pruneDeletedThreadPlacements
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
  const sortPresentation = resolveSortPresentation(groupBy);
  const folderGrouping = sortPresentation === 'folder';
  const sortBy = sortPresentation === 'flat' ? flatSortBy : groupedSortBy;

  // The three list-wide run-state projections. ONE live query (or one batched
  // read) per signal, never one per row — and each reports its own failure
  // rather than an empty result that would read as "nothing to report".
  const threadsAwaitingApproval = useThreadsAwaitingApproval({
    database,
    resourceId,
    schemaReady: Object.hasOwn(threadsByResourceId, resourceId),
  });
  const lastViewedAtByThreadId = useAssistantThreadStore((state) => state.lastViewedAtByThreadId);
  const unseenBaselineAt = useAssistantThreadStore((state) => state.unseenBaselineAt);
  const unseenThreadIds = useUnseenThreadIds({
    activeThreadId: selectedThreadId ?? null,
    lastViewedAtByThreadId,
    threads,
    unseenBaselineAt,
  });
  useMarkActiveThreadViewed({ activeThreadId: selectedThreadId ?? null, threads });

  // The folder rows behind folder grouping, and the branch chips beside them.
  // Both are requested only in folder grouping: entering it is the gesture,
  // and the branch inventory is a full repo/worktree scan across every root.
  const threadRootIds = useMemo<readonly string[]>(() => {
    if (!folderGrouping) {
      return EMPTY_ROOT_IDS;
    }
    const rootIds = new Set<string>();
    for (const thread of threads) {
      const rootId = getThreadPrimaryRootId(thread);
      if (rootId) {
        rootIds.add(rootId);
      }
    }
    return [...rootIds];
  }, [folderGrouping, threads]);
  const folderRows = useThreadFolderRows(database, threadRootIds);
  const {
    available: branchLookupAvailable,
    byRootId,
    byRootIdAndPath,
    byRootPath,
  } = useThreadBranchByRootPath({
    enabled: folderGrouping,
  });
  const branchLookup = useMemo<ThreadBranchLookup>(
    () => ({ byRootId, byRootIdAndPath, byRootPath }),
    [byRootId, byRootIdAndPath, byRootPath]
  );
  // Gated on folder grouping exactly like the branch chips: the pill only
  // exists there, and an ungated live query would subscribe every panel mount.
  const { byRepoBranch: forgePrLookup, error: forgePrError } = useForgePrCache({
    database,
    enabled: folderGrouping,
  });
  // "Has PR" can only ever match a thread while folder grouping is active AND
  // the branch lookup's bridge is present (desktop; web omits it — the
  // omit-don't-stub constraint, matching how the chips themselves disappear
  // rather than fabricating a branch). Both `branchLookup` and `forgePrLookup`
  // above are already gated on `folderGrouping` alone, so `hasPrThreadIds`
  // below is naturally empty outside that combination — this flag exists so
  // the OPTION disappears too, and so a filter left ticked from a session
  // where it worked doesn't silently strand the list at zero rows once its
  // data sources are gated again.
  const hasPrFilterAvailable = folderGrouping && branchLookupAvailable;

  // Folder sections mint persisted collapse keys; this is the symmetric prune
  // to the one `deleteGroup` does for group keys. The RESOLVED folder rows are
  // the only honest live-root evidence the panel has — an empty map also means
  // "still loading", "the folder query failed", or "not in folder grouping at
  // all", and pruning on any of those would wipe every folder's collapse state.
  const pruneFolderCollapseIds = useAssistantThreadGroupsStore(
    (state) => state.pruneFolderCollapseIds
  );
  const folderRowsByRootId = folderRows.rowsByRootId;
  const folderRowsResolved = !(folderRows.loading || folderRows.error);
  useEffect(() => {
    if (!(folderRowsResolved && folderRowsByRootId.size > 0)) {
      return;
    }
    pruneFolderCollapseIds([...folderRowsByRootId.keys()]);
  }, [folderRowsByRootId, folderRowsResolved, pruneFolderCollapseIds]);

  // Ignores a `hasPr: true` left over from a session where folder grouping
  // (or the branch lookup bridge) was available: without this, leaving that
  // mode would strand the list at zero rows behind a filter the "Has PR"
  // option has ALSO just disappeared for (see `hasPrFilterAvailable` above),
  // with no visible control left to un-tick it.
  const effectiveThreadFilters = useMemo(
    () => (hasPrFilterAvailable ? threadFilters : { ...threadFilters, hasPr: false }),
    [hasPrFilterAvailable, threadFilters]
  );
  const threadFiltersActive = hasActiveThreadFilters(effectiveThreadFilters);
  // "Has PR" is a projection over the same lookup the pill renders from, so a
  // filtered row and its pill can never disagree.
  const hasPrThreadIds = useMemo(
    () =>
      new Set(
        threads
          .filter((thread) => lookupThreadForgePr(thread, branchLookup, forgePrLookup) !== null)
          .map((thread) => thread.id)
      ),
    [branchLookup, forgePrLookup, threads]
  );
  const filteredThreads = useMemo(
    () =>
      filterThreadsByThreadFilters({
        filters: effectiveThreadFilters,
        hasPrThreadIds,
        needsYouThreadIds: threadsAwaitingApproval.threadIds,
        runningThreadIds: activeThreads.threadIds,
        threads,
        unseenThreadIds: unseenThreadIds.unseen,
      }),
    [
      activeThreads.threadIds,
      effectiveThreadFilters,
      hasPrThreadIds,
      threads,
      threadsAwaitingApproval.threadIds,
      unseenThreadIds.unseen,
    ]
  );

  const membershipByThreadId = useMemo(
    () => buildThreadMembership({ groups, placements, threads: filteredThreads }),
    [filteredThreads, groups, placements]
  );
  // The section builder's input is discriminated on `groupBy`: folder grouping
  // takes the folder rows and folder sort and no group inputs at all, so the
  // two modes are separate calls rather than one over-wide argument.
  const view = useMemo(
    () =>
      groupBy === 'folder'
        ? buildThreadListSections({
            folderRowsByRootId: folderRows.rowsByRootId,
            folderSortBy,
            groupBy,
            threads: filteredThreads,
          })
        : buildThreadListSections({
            groupBy,
            groups,
            placements,
            sortBy,
            threads: filteredThreads,
          }),
    [filteredThreads, folderRows.rowsByRootId, folderSortBy, groupBy, groups, placements, sortBy]
  );
  const moveTargets = useMemo(
    () => groups.map((group) => ({ id: group.id, name: group.name })),
    [groups]
  );
  // Disclosure limits + bulk selection live here so the toolbar's count and
  // select-visible toggle read the same state the treegrid renders. FILTERED
  // threads, not all of them: a thread the Show only filters removed is not in
  // the list, so it must not stay in a selection whose action bar the user
  // reads as "these rows".
  const selection = useThreadPanelSelection({ collapsedGroupIds, threads: filteredThreads, view });
  // An unresolved or failed folder map is EMPTY, and an empty map files every
  // thread under "No folder" — so in folder grouping both replace the tree.
  const folderGroupingState = folderGrouping
    ? { error: folderRows.error, loading: folderRows.loading }
    : null;
  const contentState = resolveThreadPanelContentState({
    databaseError,
    databaseStartupLoading,
    folderGrouping: folderGroupingState,
    loadState,
    repositoryReady: Boolean(repository),
    threadFiltersActive,
    threads: filteredThreads,
    view,
  });

  // Thread hybrid search: repository + controller (debounce, sync, embedding
  // backlog) + honest semantic availability. See use-thread-search-controller.
  const embedder = useSharedSearchEmbedder();
  useEnsureModelRegistry({ db: database });
  const registryModels = useModelRegistryStore((state) => state.models);
  const localModelConfigMap = useMemo(
    () => buildLocalEmbeddingModelConfigMap(registryModels),
    [registryModels]
  );
  const { retrySearch } = useThreadSearchController({
    embedder,
    loadEmbeddingQueue,
    localModelConfigMap,
    repository: threadSearchRepository,
    resourceId,
  });
  const searchActive = useThreadSearchStore((state) => state.status !== 'idle');
  // The count and the select-visible toggle describe the treegrid. Withdraw
  // them whenever something else stands in for it — a state card, or search
  // results (whose bulk-selection overlay lives inside the hidden subtree, so a
  // live toggle would select threads the user cannot see or clear).
  const treeOnScreen = contentState.kind === 'tree' && !searchActive;
  const threadsById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads]
  );
  const groupNameByThreadId = useMemo(() => {
    const nameByGroupId = new Map(groups.map((group) => [group.id, group.name]));
    const names = new Map<string, string>();
    for (const placement of placements) {
      if (placement.groupId) {
        const name = nameByGroupId.get(placement.groupId);
        if (name) {
          names.set(placement.threadId, name);
        }
      }
    }
    return names;
  }, [groups, placements]);

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
    // Search-index rows for a deleted thread are inert (query-time join by
    // id) and swept by the sync GC, but clear them eagerly like placements.
    if (threadSearchRepository) {
      await threadSearchRepository.deleteThreads([threadId]);
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
  const handleBulkColor = async (
    threadIds: readonly string[],
    color: AssistantThreadColorId
  ): Promise<void> => {
    if (!repository) {
      throw new Error('Assistant memory database unavailable.');
    }
    await updateThreadsMetadata(repository, resourceId, threadIds, { color });
  };
  const handleBulkDelete = async (threadIds: readonly string[]): Promise<void> => {
    if (!repository) {
      throw new Error('Assistant memory database unavailable.');
    }
    await deleteThreads(repository, resourceId, threadIds);
    pruneDeletedThreadPlacements(threadIds);
    if (threadSearchRepository) {
      await threadSearchRepository.deleteThreads(threadIds);
    }
  };
  const handleBulkMove = async (
    threadIds: readonly string[],
    groupId: string | null
  ): Promise<void> => {
    if (!groupsRepository) {
      throw new Error('Assistant thread groups database unavailable.');
    }
    await moveThreadsToGroup(groupsRepository, resourceId, threadIds, groupId);
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
  const handleCreateThreadInFolder = useCreateThreadInFolder();
  const handleSortByChange = (nextSortBy: ThreadsPanelSortBy): void => {
    if (sortPresentation === 'folder') {
      // Unreachable through the popover, which binds folder mode to
      // `setFolderSortBy`. Loud rather than silently writing the grouped sort.
      throw new Error('Folder grouping sorts through setFolderSortBy, not setSortBy.');
    }
    setSortBy(sortPresentation, nextSortBy);
  };
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
        filtersActive: threadFiltersActive,
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
                view.kind === 'flat' ? 'flat' : 'grouped',
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
      threadFiltersActive,
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
      className="@container/threads flex h-full min-h-0 flex-col overflow-hidden border-border border-b bg-muted/20"
      data-testid="threads-panel"
    >
      <ThreadsPanelToolbar
        folderSortBy={folderSortBy}
        groupBy={groupBy}
        hasPrFilterAvailable={hasPrFilterAvailable}
        newGroupDisabled={!groupsRepository}
        newThreadDisabled={!(repository && resourceId) || loadState?.status === 'loading'}
        newThreadTitle={
          repository
            ? 'Create a new Mastra memory thread for this workspace.'
            : 'The assistant memory database is still initializing.'
        }
        onClearThreadFilters={clearThreadFilters}
        onCreateGroup={handleCreateGroup}
        onCreateThread={() => {
          if (!(repository && resourceId)) {
            return;
          }
          createThread(repository, resourceId).catch(() => {
            // The store records the explicit error state; no fallback thread source is used.
          });
        }}
        onFolderSortByChange={setFolderSortBy}
        onGroupByChange={setGroupBy}
        onSortByChange={handleSortByChange}
        onThreadFilterChange={setThreadFilter}
        selection={selection}
        sortBy={sortBy}
        threadFilters={threadFilters}
        treeOnScreen={treeOnScreen}
      />

      <ThreadsPanelSearch
        groupNameByThreadId={groupNameByThreadId}
        onRetry={retrySearch}
        onSelectThread={handleSelectThread}
        threadsById={threadsById}
      />

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
      {activeThreads.error ? (
        <p className="px-3 pb-2 text-[11px] text-destructive" data-testid="thread-activity-error">
          Active thread status unavailable: {activeThreads.error.message}
        </p>
      ) : null}
      {threadsAwaitingApproval.error ? (
        <p className="px-3 pb-2 text-[11px] text-destructive" data-testid="thread-approvals-error">
          Approval status unavailable: {threadsAwaitingApproval.error.message}
        </p>
      ) : null}
      {forgePrError ? (
        <p className="px-3 pb-2 text-[11px] text-destructive" data-testid="thread-pr-status-error">
          Pull request status unavailable: {forgePrError.message}
        </p>
      ) : null}

      <div className={searchActive ? 'hidden' : 'flex min-h-0 flex-1 overflow-hidden'}>
        <ThreadsPanelContent
          activeThreadIds={activeThreads.threadIds}
          branchLookup={branchLookup}
          databaseError={databaseError}
          databaseStartupLoading={databaseStartupLoading}
          failedUnseenThreadIds={unseenThreadIds.failedUnseen}
          folderGrouping={folderGroupingState}
          forgePrLookup={forgePrLookup}
          groupHandlers={{
            collapsedGroupIds,
            onDeleteGroup: handleDeleteGroup,
            onGroupColorChange: (groupId, color) => {
              if (!groupsRepository) {
                return;
              }
              setGroupActionError(null);
              setGroupColor(groupsRepository, resourceId, groupId, color).catch(
                (error: unknown) => {
                  setGroupActionError(error instanceof Error ? error.message : String(error));
                }
              );
            },
            onGroupIconChange: (groupId, icon) => {
              if (!groupsRepository) {
                return;
              }
              setGroupActionError(null);
              setGroupIcon(groupsRepository, resourceId, groupId, icon).catch((error: unknown) => {
                setGroupActionError(error instanceof Error ? error.message : String(error));
              });
            },
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
          needsYouThreadIds={threadsAwaitingApproval.threadIds}
          onBulkColor={handleBulkColor}
          onBulkDelete={handleBulkDelete}
          onBulkMove={handleBulkMove}
          onDeleteThread={handleDeleteThread}
          onMoveThreadToGroup={handleMoveThreadToGroup}
          onNewThreadInFolder={handleCreateThreadInFolder}
          onRenameThread={handleRenameThread}
          onSelectThread={handleSelectThread}
          onUpdateThreadMetadata={handleUpdateThreadMetadata}
          repository={repository}
          selectedThreadId={selectedThreadId}
          selection={selection}
          threadFiltersActive={threadFiltersActive}
          threads={filteredThreads}
          unseenThreadIds={unseenThreadIds.unseen}
          view={view}
        />
      </div>
    </section>
  );
}
