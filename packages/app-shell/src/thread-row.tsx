import {
  ASSISTANT_THREAD_ICON_IDS,
  type AssistantMemoryThread,
  type AssistantThreadColorId,
  type AssistantThreadIconId,
  type AssistantThreadMetadata,
} from '@brainstrike/assistant-data';
import {
  type AnyContextAction,
  defineContextAction,
  type TargetOf,
} from '@brainstrike/context-actions';
import type { ForgePrCacheEntry } from '@brainstrike/types';
import {
  ActionContextMenu,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  useContextMenuTarget,
} from '@brainstrike/ui';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Folder,
  FolderMinus,
  MessageSquare,
  MoreHorizontal,
  Palette,
  Pencil,
  SwatchBook,
  Trash2,
  X,
} from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { assistantThreadToTarget } from './assistant-thread-context-actions';
import {
  ASSISTANT_THREAD_COLOR_PALETTES,
  ASSISTANT_THREAD_COLOR_PRESENTATION,
  ASSISTANT_THREAD_ICON_PRESENTATION,
  getAssistantThreadColorSurface,
  THREAD_CONTROL_ACTION_CLASS_NAME,
  THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME,
  THREAD_CONTROL_TITLE_CLASS_NAME,
  type ThreadRowStatusState,
} from './assistant-thread-presentation';
import type { ThreadBranchInfo } from './hooks/use-thread-branch-by-root-path';
import { ThreadColorFamilyPreview } from './thread-color-family-preview';
import { ThreadIdentityMark } from './thread-identity-mark';
import {
  ThreadExpandedDetails,
  ThreadMetadataBadges,
  ThreadReadFailureMarker,
} from './thread-row-metadata';
import { ThreadRowDndShell } from './threads-panel-dnd-elements';

function getThreadIconId(thread: AssistantMemoryThread): AssistantThreadIconId {
  return thread.metadata?.icon ?? 'message';
}

function getThreadColorId(thread: AssistantMemoryThread): AssistantThreadColorId | null {
  return thread.metadata?.color ?? null;
}

function getThreadColorConfig(thread: AssistantMemoryThread) {
  return getAssistantThreadColorSurface(getThreadColorId(thread));
}

export interface ThreadMoveTarget {
  readonly id: string;
  readonly name: string;
}

export interface ThreadRowProps {
  readonly branch: ThreadBranchInfo | null;
  readonly draggable: boolean;
  readonly groupId: string | null;
  readonly moveTargets: readonly ThreadMoveTarget[];
  readonly onDeleteThread: (threadId: string) => Promise<void>;
  readonly onMoveThreadToGroup: (threadId: string, groupId: string | null) => Promise<void>;
  readonly onRefreshAgentColors?:
    | ((threadId: string, ownerResourceId: string) => Promise<number>)
    | undefined;
  readonly onRenameThread: (threadId: string, title: string) => Promise<void>;
  readonly onSelectThread: (threadId: string) => void;
  readonly onUpdateThreadMetadata: (
    threadId: string,
    metadata: AssistantThreadMetadata
  ) => Promise<void>;
  readonly pr: ForgePrCacheEntry | null;
  readonly selected: boolean;
  readonly status: ThreadRowStatusState | null;
  readonly thread: AssistantMemoryThread;
}

export function ThreadRow({
  branch,
  draggable,
  groupId,
  moveTargets,
  onDeleteThread,
  onMoveThreadToGroup,
  onRenameThread,
  onRefreshAgentColors,
  onSelectThread,
  onUpdateThreadMetadata,
  pr,
  selected,
  status,
  thread,
}: ThreadRowProps): ReactElement {
  const [customizing, setCustomizing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [refreshingColors, setRefreshingColors] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [savingRename, setSavingRename] = useState(false);
  const handleCustomizeThreadToggle = useCallback(() => {
    setCustomizing((current) => !current);
    setMetadataError(null);
  }, []);
  const handleDeleteThreadStart = useCallback(() => {
    setConfirmingDelete(true);
    setDeleteError(null);
    setCustomizing(false);
  }, []);
  const handleExpandedThreadToggle = useCallback(() => {
    setExpanded((current) => !current);
  }, []);
  const handleRenameThreadStart = useCallback(() => {
    setEditing(true);
    setDraftTitle(thread.title);
    setRenameError(null);
    setCustomizing(false);
  }, [thread.title]);

  return (
    <ThreadRowDragScope draggable={draggable} groupId={groupId} threadId={thread.id}>
      <ThreadRowItem
        branch={branch}
        confirmingDelete={confirmingDelete}
        customizing={customizing}
        deleteError={deleteError}
        deleting={deleting}
        draftTitle={draftTitle}
        editing={editing}
        expanded={expanded}
        metadataError={metadataError}
        metadataSaving={savingMetadata}
        moveTargets={moveTargets}
        onCancelRename={() => {
          setEditing(false);
          setDraftTitle('');
          setRenameError(null);
        }}
        onConfirmDeleteThread={() => {
          setDeleting(true);
          setDeleteError(null);
          onDeleteThread(thread.id)
            .then(() => {
              setConfirmingDelete(false);
            })
            .catch((error: unknown) => {
              setDeleteError(error instanceof Error ? error.message : String(error));
            })
            .finally(() => {
              setDeleting(false);
            });
        }}
        onCustomizeThreadToggle={handleCustomizeThreadToggle}
        onDeleteThreadCancel={() => {
          setConfirmingDelete(false);
          setDeleteError(null);
        }}
        onDeleteThreadStart={handleDeleteThreadStart}
        onDraftTitleChange={setDraftTitle}
        onExpandedThreadToggle={handleExpandedThreadToggle}
        onMetadataError={setMetadataError}
        onMetadataSavingChange={setSavingMetadata}
        onMoveThreadToGroup={onMoveThreadToGroup}
        onRefreshAgentColors={onRefreshAgentColors}
        onRefreshingColorsChange={setRefreshingColors}
        onRefreshMessage={setRefreshMessage}
        onRenameSavingChange={setSavingRename}
        onRenameThread={onRenameThread}
        onRenameThreadStart={handleRenameThreadStart}
        onRenameThreadSubmitError={setRenameError}
        onRenameThreadSubmitted={() => {
          setEditing(false);
          setDraftTitle('');
        }}
        onSelectThread={onSelectThread}
        onUpdateThreadMetadata={onUpdateThreadMetadata}
        pr={pr}
        refreshingColors={refreshingColors}
        refreshMessage={refreshMessage}
        renameError={renameError}
        renameSaving={savingRename}
        rowGroupId={groupId}
        selected={selected}
        status={status}
        thread={thread}
      />
    </ThreadRowDragScope>
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

function ThreadRowItem({
  branch,
  confirmingDelete,
  customizing,
  deleteError,
  deleting,
  draftTitle,
  editing,
  expanded,
  metadataSaving,
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
  onRefreshAgentColors,
  onRefreshMessage,
  onRefreshingColorsChange,
  onRenameThreadStart,
  onRenameThreadSubmitted,
  onRenameThreadSubmitError,
  onMetadataSavingChange,
  onRenameSavingChange,
  onSelectThread,
  onUpdateThreadMetadata,
  pr,
  renameError,
  renameSaving,
  refreshMessage,
  refreshingColors,
  rowGroupId,
  selected,
  status,
  thread,
}: {
  readonly branch: ThreadBranchInfo | null;
  readonly confirmingDelete: boolean;
  readonly customizing: boolean;
  readonly deleteError: string | null;
  readonly deleting: boolean;
  readonly draftTitle: string;
  readonly editing: boolean;
  readonly expanded: boolean;
  readonly metadataSaving: boolean;
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
  readonly onRefreshAgentColors?:
    | ((threadId: string, ownerResourceId: string) => Promise<number>)
    | undefined;
  readonly onRefreshMessage: (message: string | null) => void;
  readonly onRefreshingColorsChange: (refreshing: boolean) => void;
  readonly onRenameThreadStart: () => void;
  readonly onRenameThreadSubmitted: () => void;
  readonly onRenameThreadSubmitError: (message: string) => void;
  readonly onMetadataSavingChange: (saving: boolean) => void;
  readonly onRenameSavingChange: (saving: boolean) => void;
  readonly onSelectThread: (threadId: string) => void;
  readonly onUpdateThreadMetadata: (
    threadId: string,
    metadata: AssistantThreadMetadata
  ) => Promise<void>;
  readonly pr: ForgePrCacheEntry | null;
  readonly renameError: string | null;
  readonly renameSaving: boolean;
  readonly refreshMessage: string | null;
  readonly refreshingColors: boolean;
  readonly rowGroupId: string | null;
  readonly selected: boolean;
  readonly status: ThreadRowStatusState | null;
  readonly thread: AssistantMemoryThread;
}): ReactElement {
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
        isEnabled: (target) => isCurrentTarget(target) && !selected,
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
        label: customizing ? 'Close Customization' : 'Customize…',
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
        icon: expanded ? ChevronUp : ChevronDown,
        id: 'assistant-thread.toggle-details',
        isEnabled: (target) => isCurrentTarget(target),
        label: expanded ? 'Hide Details' : 'Show Details',
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
        isEnabled: (target) => isCurrentTarget(target) && !confirmingDelete,
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
    confirmingDelete,
    customizing,
    expanded,
    moveTargets,
    onCustomizeThreadToggle,
    onDeleteThreadStart,
    onExpandedThreadToggle,
    onMoveThreadToGroup,
    onRenameThreadStart,
    onSelectThread,
    rowGroupId,
    selected,
    thread.id,
    thread.resourceId,
  ]);
  return (
    <div
      className={`my-0.5 flex ${THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME} w-auto flex-col justify-center overflow-hidden rounded-md px-2 text-left transition-[background-color,box-shadow] motion-reduce:transition-none ${
        selected ? colorConfig.selectedClassName : colorConfig.idleClassName
      }`}
      data-testid="thread-row"
    >
      {editing ? (
        <ThreadRenameForm
          draftTitle={draftTitle}
          onCancelRename={onCancelRename}
          onDraftTitleChange={onDraftTitleChange}
          onRenameThread={onRenameThread}
          onRenameThreadSubmitError={onRenameThreadSubmitError}
          onRenameThreadSubmitted={onRenameThreadSubmitted}
          onSavingChange={onRenameSavingChange}
          renameError={renameError}
          saving={renameSaving}
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
              customizing={customizing}
              deleteError={confirmingDelete ? deleteError : null}
              deleting={deleting}
              expanded={expanded}
              metadataError={customizing ? metadataError : null}
              metadataSaving={metadataSaving}
              onConfirmDeleteThread={onConfirmDeleteThread}
              onCustomizeThreadToggle={onCustomizeThreadToggle}
              onDeleteThreadCancel={onDeleteThreadCancel}
              onDeleteThreadStart={onDeleteThreadStart}
              onExpandedThreadToggle={onExpandedThreadToggle}
              onMetadataError={onMetadataError}
              onMetadataSavingChange={onMetadataSavingChange}
              onRefreshAgentColors={onRefreshAgentColors}
              onRefreshingColorsChange={onRefreshingColorsChange}
              onRefreshMessage={onRefreshMessage}
              onRenameThreadStart={onRenameThreadStart}
              onSelectThread={onSelectThread}
              onUpdateThreadMetadata={onUpdateThreadMetadata}
              pendingDelete={confirmingDelete}
              pr={pr}
              refreshingColors={refreshingColors}
              refreshMessage={refreshMessage}
              selected={selected}
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
  onSavingChange,
  renameError,
  saving,
  status,
  thread,
}: {
  readonly draftTitle: string;
  readonly onCancelRename: () => void;
  readonly onDraftTitleChange: (title: string) => void;
  readonly onRenameThread: (threadId: string, title: string) => Promise<void>;
  readonly onRenameThreadSubmitted: () => void;
  readonly onRenameThreadSubmitError: (message: string) => void;
  readonly onSavingChange: (saving: boolean) => void;
  readonly renameError: string | null;
  readonly saving: boolean;
  readonly status: ThreadRowStatusState | null;
  readonly thread: AssistantMemoryThread;
}): ReactElement {
  return (
    <form
      className={`flex ${THREAD_CONTROL_MIN_HEIGHT_CLASS_NAME} items-center gap-2`}
      onSubmit={(event) => {
        event.preventDefault();
        onSavingChange(true);
        onRenameThread(thread.id, draftTitle)
          .then(onRenameThreadSubmitted)
          .catch((error: unknown) => {
            onRenameThreadSubmitError(error instanceof Error ? error.message : String(error));
          })
          .finally(() => {
            onSavingChange(false);
          });
      }}
    >
      <ThreadIdentityMark status={status} thread={thread} />
      <input
        aria-label="Thread title"
        autoFocus
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
        disabled={saving}
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
  onMetadataSavingChange,
  onRefreshAgentColors,
  onRefreshMessage,
  onRefreshingColorsChange,
  onSelectThread,
  onUpdateThreadMetadata,
  pendingDelete,
  pr,
  refreshMessage,
  refreshingColors,
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
  readonly onMetadataSavingChange: (saving: boolean) => void;
  readonly onRefreshAgentColors?:
    | ((threadId: string, ownerResourceId: string) => Promise<number>)
    | undefined;
  readonly onRefreshMessage: (message: string | null) => void;
  readonly onRefreshingColorsChange: (refreshing: boolean) => void;
  readonly onSelectThread: (threadId: string) => void;
  readonly onUpdateThreadMetadata: (
    threadId: string,
    metadata: AssistantThreadMetadata
  ) => Promise<void>;
  readonly pendingDelete: boolean;
  readonly pr: ForgePrCacheEntry | null;
  readonly refreshMessage: string | null;
  readonly refreshingColors: boolean;
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
          <ThreadReadFailureMarker reason={thread.readFailure} title={thread.title} />
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
                  ? 'max-h-[calc(var(--radix-popover-content-available-height)-1rem)] w-64 max-w-[calc(var(--radix-popover-content-available-width)-0.5rem)] overflow-y-auto p-3'
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
                  onMetadataSavingChange={onMetadataSavingChange}
                  onRefreshAgentColors={onRefreshAgentColors}
                  onRefreshingColorsChange={onRefreshingColorsChange}
                  onRefreshMessage={onRefreshMessage}
                  onUpdateThreadMetadata={onUpdateThreadMetadata}
                  refreshingColors={refreshingColors}
                  refreshMessage={refreshMessage}
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
            Delete this thread, its delegated children, and saved conversation data permanently?
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

function ThreadCustomizationPanel({
  metadataError,
  metadataSaving,
  onMetadataError,
  onMetadataSavingChange,
  onRefreshAgentColors,
  onRefreshMessage,
  onRefreshingColorsChange,
  onUpdateThreadMetadata,
  refreshMessage,
  refreshingColors,
  thread,
}: {
  readonly metadataError: string | null;
  readonly metadataSaving: boolean;
  readonly onMetadataError: (message: string | null) => void;
  readonly onMetadataSavingChange: (saving: boolean) => void;
  readonly onRefreshAgentColors?:
    | ((threadId: string, ownerResourceId: string) => Promise<number>)
    | undefined;
  readonly onRefreshMessage: (message: string | null) => void;
  readonly onRefreshingColorsChange: (refreshing: boolean) => void;
  readonly onUpdateThreadMetadata: (
    threadId: string,
    metadata: AssistantThreadMetadata
  ) => Promise<void>;
  readonly refreshMessage: string | null;
  readonly refreshingColors: boolean;
  readonly thread: AssistantMemoryThread;
}): ReactElement {
  const saveMetadata = (metadata: AssistantThreadMetadata): void => {
    onMetadataSavingChange(true);
    onMetadataError(null);
    onUpdateThreadMetadata(thread.id, metadata)
      .catch((error: unknown) => {
        onMetadataError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        onMetadataSavingChange(false);
      });
  };
  return (
    <div className="grid gap-3" data-testid="thread-customization-panel">
      <div>
        <div className="font-medium text-xs">Thread appearance</div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">Choose an icon and color.</p>
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
                  disabled={metadataSaving || refreshingColors}
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
          <div className="mb-1.5 text-[11px] text-muted-foreground">Color palette</div>
          <div className="grid gap-2.5">
            {ASSISTANT_THREAD_COLOR_PALETTES.map((palette) => (
              <div key={palette.label}>
                <div className="mb-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
                  {palette.label}
                </div>
                <fieldset
                  aria-label={`${palette.label} colors`}
                  className="grid grid-cols-6 gap-1"
                  data-testid={`thread-color-palette-${palette.label.toLowerCase()}`}
                >
                  {palette.colors.map((colorId) => {
                    const label = ASSISTANT_THREAD_COLOR_PRESENTATION[colorId].label;
                    const selected = getThreadColorId(thread) === colorId;
                    return (
                      <Button
                        aria-label={`Use ${label} color`}
                        aria-pressed={selected}
                        className={
                          selected ? 'bg-accent shadow-inner ring-1 ring-border' : undefined
                        }
                        disabled={metadataSaving || refreshingColors}
                        key={colorId}
                        onClick={() => saveMetadata({ color: colorId })}
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
                </fieldset>
              </div>
            ))}
          </div>
          <ThreadColorFamilyPreview rootColor={getThreadColorId(thread)} />
          {onRefreshAgentColors ? (
            <div className="mt-2 border-t pt-2">
              <Button
                className="w-full"
                disabled={refreshingColors || metadataSaving}
                onClick={() => {
                  onRefreshingColorsChange(true);
                  onRefreshMessage(null);
                  onRefreshAgentColors(thread.id, thread.resourceId)
                    .then((changed) => {
                      onRefreshMessage(
                        changed === 0
                          ? 'Saved agent colors are already up to date.'
                          : `Refreshed ${changed} saved agent ${changed === 1 ? 'color' : 'colors'}.`
                      );
                    })
                    .catch((error: unknown) => {
                      onRefreshMessage(error instanceof Error ? error.message : String(error));
                    })
                    .finally(() => onRefreshingColorsChange(false));
                }}
                size="sm"
                type="button"
                variant="secondary"
              >
                {refreshingColors ? 'Refreshing agent colors…' : 'Refresh agent colors'}
              </Button>
              {refreshMessage ? (
                <p className="mt-1 text-[11px]" role="status">
                  {refreshMessage}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {metadataError ? <p className="text-[11px] text-destructive">{metadataError}</p> : null}
    </div>
  );
}
