import { hasFactoryResetPreparationStarted } from '@brainstrike/app-state/factory-reset';
import {
  ASSISTANT_THREAD_ICON_IDS,
  type AssistantMemoryThread,
  type AssistantThreadAppearancePatch,
  type AssistantThreadCatalogRepository,
  type AssistantThreadColorId,
  type AssistantThreadGroup,
  type AssistantThreadGroupsRepository,
  type AssistantThreadIconId,
  buildThreadListSections,
  buildThreadMembership,
  getGroupMemberIds,
  getThreadLastActivityAt,
  type ThreadFilters,
  type ThreadFolderRow,
  type ThreadListOrdering,
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
} from '@brainstrike/ui';
import {
  ArrowLeft,
  CalendarDays,
  Check,
  CheckCheck,
  Folder,
  FolderMinus,
  FolderPlus,
  ListChecks,
  MoreHorizontal,
  Palette,
  Pencil,
  Pin,
  Plus,
  SwatchBook,
  Trash2,
  X,
} from 'lucide-react';
import type { KeyboardEvent, ReactElement, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  type AssistantThreadHostCapability,
  createHostAssistantThreadRepository,
  useAssistantThreadHost,
  useAssistantThreadHostRuns,
} from './assistant-thread-host-context';
import {
  ASSISTANT_THREAD_COLOR_PALETTES,
  ASSISTANT_THREAD_COLOR_PRESENTATION,
  ASSISTANT_THREAD_ICON_PRESENTATION,
  resolveThreadRowStatusState,
  THREAD_CONTROL_ACTION_CLASS_NAME,
  THREAD_PANEL_ROW_CLASS_NAME,
} from './assistant-thread-presentation';
import { DelegatedSidebarCell } from './delegated-sidebar-cell';
import { useOnScreenThreadId } from './hooks/use-on-screen-thread';
import { useThreadFolderGrouping } from './hooks/use-thread-folder-grouping';
import { useUnseenThreadIds } from './hooks/use-unseen-thread-ids';
import { HostChildSidebarCell } from './host-child-sidebar-cell';
import { useSidebarHeader } from './sidebar-header';
import { ThreadFolderHeader } from './thread-folder-header';
import {
  createNativeThreadGroupsRepository,
  getThreadGroupsCapability,
} from './thread-groups-capability';
import { ThreadMarkChip } from './thread-identity-mark';
import { buildThreadNeedsYouRows } from './thread-needs-you';
import {
  filterThreadsByThreadFilters,
  hasActiveThreadFilters,
  resolveThreadPanelContentState,
  type ThreadPanelFolderGroupingState,
  type ThreadPanelLoadState,
} from './thread-panel-content-state';
import {
  filterThreadPanelSelection,
  getThreadPanelCollapseId,
  getThreadPanelMemberSectionId,
  getThreadPanelRowHeightPx,
  THREAD_PANEL_DISCLOSURE_INCREMENT,
  type ThreadPanelGroupRow,
  type ThreadPanelVisibleRow,
} from './thread-panel-visible-rows';
import { mapThreadRepositories } from './thread-repositories';
import { type ThreadMoveTarget, type ThreadPinHandler, ThreadRow } from './thread-row';
import { useThreadSearchStore } from './thread-search-store';
import { ThreadSectionHeader } from './thread-section-header';
import { ThreadsNeedsYouStrip } from './threads-needs-you-strip';
import {
  resolveThreadsPanelDrop,
  type ThreadsPanelDragSource,
  type ThreadsPanelDropTarget,
} from './threads-panel-dnd';
import {
  GroupBodyDndShell,
  GroupHeaderDndShell,
  UngroupedSectionDndShell,
  useThreadsPanelDropMonitor,
} from './threads-panel-dnd-elements';
import { ThreadsPanelSearch } from './threads-panel-search';
import { ThreadsViewOptionsPopover } from './threads-panel-view-options';
import { useHostChildSidebar } from './use-host-child-sidebar';
import { type ThreadPanelSelection, useThreadPanelSelection } from './use-thread-panel-selection';
import { useThreadSearchController } from './use-thread-search-controller';
import { useThreadSearchResultNavigation } from './use-thread-search-result-navigation';
import { useThreadSearchTitles } from './use-thread-search-titles';

// Stable fallback so `threads` keeps referential identity across renders when
// the resource has no entry yet (the membership/view useMemos depend on it).
const EMPTY_THREADS: readonly AssistantMemoryThread[] = [];
// Stable identity so folder mode's empty input does not churn memo deps.
const EMPTY_MOVE_TARGETS: readonly ThreadMoveTarget[] = [];

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
  // The lane takes the search field's inset so both edges line up.
  return (
    <div className="w-full min-w-0 px-3">
      <div className={className} data-testid={testId}>
        <div className="text-sm font-medium">{title}</div>
        <p className="text-muted-foreground pt-2 text-xs leading-5">{description}</p>
      </div>
    </div>
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
        className="border-border bg-background focus-visible:ring-ring min-w-0 flex-1 rounded-md border px-2 py-1 text-[13px] leading-4 outline-hidden focus-visible:ring-2"
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
  const GroupIcon = group.icon
    ? ASSISTANT_THREAD_ICON_PRESENTATION[group.icon].iconComponent
    : Folder;
  const mark = (
    <ThreadMarkChip
      color={group.color}
      testId={`thread-group-color-${group.color ?? 'unassigned'}`}
    >
      <GroupIcon className="size-3" data-testid={`thread-group-icon-${group.icon ?? 'folder'}`} />
    </ThreadMarkChip>
  );
  return (
    <div className="min-w-0" data-testid="thread-group-header">
      {renameForm ? (
        <div className={`${THREAD_PANEL_ROW_CLASS_NAME} items-center gap-2`}>
          {mark}
          {renameForm}
        </div>
      ) : (
        <ThreadSectionHeader
          actions={
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
                  className={THREAD_CONTROL_ACTION_CLASS_NAME}
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
                        <div className="text-xs font-medium">Group appearance</div>
                        <p className="text-muted-foreground text-2xs">Choose an icon and color.</p>
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-2xs mb-1">Icon</div>
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
                                  ? 'bg-accent ring-border shadow-inner ring-1'
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
                          className="text-muted-foreground text-2xs col-span-6 h-7 justify-start gap-2 px-2"
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
                    <div className="text-muted-foreground text-2xs">Color palette</div>
                    <div className="grid gap-2" data-testid="thread-group-color-grid">
                      {ASSISTANT_THREAD_COLOR_PALETTES.map((palette) => (
                        <div key={palette.label}>
                          <div className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wide uppercase">
                            {palette.label}
                          </div>
                          <fieldset
                            aria-label={`${palette.label} colors`}
                            className="grid grid-cols-6 gap-1"
                          >
                            {palette.colors.map((colorId) => (
                              <Button
                                aria-label={`Use ${ASSISTANT_THREAD_COLOR_PRESENTATION[colorId].label} color for ${group.name}`}
                                aria-pressed={group.color === colorId}
                                className={
                                  group.color === colorId
                                    ? 'bg-accent ring-border shadow-inner ring-1'
                                    : undefined
                                }
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
                          </fieldset>
                        </div>
                      ))}
                      <Button
                        aria-label={`Clear color for ${group.name}`}
                        aria-pressed={group.color === null}
                        className={`text-2xs h-7 justify-start gap-2 px-2 ${
                          group.color === null ? 'bg-accent ring-border shadow-inner ring-1' : ''
                        }`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onColorChange(null);
                        }}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        <span
                          aria-hidden="true"
                          className="border-border bg-muted size-4 rounded-full border"
                        />
                        No color
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
                      className="text-destructive hover:text-destructive h-8 justify-start gap-2 px-2 text-xs"
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
          }
          count={threadCount}
          countTestId="thread-group-count"
          label={group.name}
          mark={mark}
          testId="thread-group-header-row"
        />
      )}
      {confirmingDelete ? (
        <div className="border-destructive/30 bg-destructive/5 mx-1 mb-1 rounded-lg border p-2">
          <p className="text-destructive text-2xs">Delete folder {group.name}?</p>
          <p className="text-muted-foreground text-2xs mt-0.5">Its threads return to Ungrouped.</p>
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
  rows: readonly ThreadPanelVisibleRow[],
  hasChildren: (row: ThreadPanelVisibleRow) => boolean
): TreeNode<ThreadPanelVisibleRow>[] {
  return rows.map((row) => ({
    data: row,
    depth:
      row.kind === 'delegated-state' || row.kind === 'host-child'
        ? row.depth
        : row.kind === 'group'
          ? 0
          : row.parentId === null
            ? 0
            : 1,
    // Disclosure is already applied by buildThreadPanelVisibleRows, but every
    // section header remains an expandable treegrid parent so aria-expanded
    // and the shared Left/Right keyboard contract expose a symmetric tree.
    hasChildren: row.kind === 'group' || hasChildren(row),
    id: row.id,
    parentId: row.kind === 'group' ? null : row.parentId,
    type: `thread-panel-${row.kind}`,
  }));
}

/** Accessible name of a section, whatever kind of section it is. */
function getThreadPanelSectionLabel(row: ThreadPanelGroupRow): string {
  switch (row.header.kind) {
    case 'group':
      return row.header.group.name;
    case 'folder':
      return row.header.folder.displayName;
    case 'repository':
      return row.header.repository.displayName;
    case 'unassigned':
      return 'No project';
    case 'date':
      return row.header.label;
    case 'pinned':
      return 'Pinned';
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

interface ThreadRowContextProps {
  readonly activeThreadIds: ReadonlySet<string>;
  readonly failedUnseenThreadIds: ReadonlySet<string>;
  /** Folder sections project a thread's root binding; they are not move targets. */
  readonly folderMode: boolean;
  readonly membershipByThreadId: ReadonlyMap<string, string | null>;
  readonly moveTargets: readonly ThreadMoveTarget[];
  readonly needsYouThreadIds: ReadonlySet<string>;
  readonly onDeleteThread: (threadId: string) => Promise<void>;
  readonly onMoveThreadToGroup: (threadId: string, groupId: string | null) => Promise<void>;
  readonly onRenameThread: (threadId: string, title: string) => Promise<void>;
  readonly onSelectThread: (threadId: string) => void;
  readonly onSetThreadPinned: ThreadPinHandler | null;
  readonly onUpdateThreadAppearance: (
    threadId: string,
    patch: AssistantThreadAppearancePatch
  ) => Promise<void>;
  readonly pinnedAtByThreadId: Readonly<Record<string, number>>;
  /**
   * False for folder and date grouping and while a Show-only filter narrows
   * the list. A pinned row never drags: the Pinned section has no order to
   * rewrite and no membership to change.
   */
  readonly rowsDraggable: boolean;
  readonly selectedThreadId: string | undefined;
  readonly unseenThreadIds: ReadonlySet<string>;
}

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
    <div className="my-0.5 flex min-h-7 items-center justify-between gap-3 pr-1">
      <Button
        aria-label={`Show ${disclosureCount} more threads`}
        className="text-muted-foreground hover:text-foreground h-7 px-1 text-xs"
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
      <span className="text-muted-foreground text-2xs shrink-0 tabular-nums">
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
      className="border-border/45 text-muted-foreground text-2xs my-0.5 flex min-h-9 items-center rounded-md border border-dashed px-2"
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
  if (header.kind === 'date' || header.kind === 'pinned') {
    const pinnedSection = header.kind === 'pinned';
    return (
      <div data-testid="thread-group-section">
        <ThreadSectionHeader
          count={row.totalCount}
          countTestId="thread-section-count"
          label={pinnedSection ? 'Pinned' : header.label}
          mark={
            <ThreadMarkChip color={null}>
              {pinnedSection ? <Pin className="size-3" /> : <CalendarDays className="size-3" />}
            </ThreadMarkChip>
          }
          muted={!pinnedSection}
          testId={pinnedSection ? 'threads-pinned-section' : 'thread-date-section'}
        />
      </div>
    );
  }
  if (header.kind === 'folder' || header.kind === 'repository' || header.kind === 'unassigned') {
    return (
      <div data-testid="thread-group-section">
        <ThreadFolderHeader
          header={header}
          onNewThreadHere={onNewThreadInFolder}
          threadCount={row.totalCount}
        />
      </div>
    );
  }
  if (header.kind === 'ungrouped') {
    return (
      <UngroupedSectionDndShell>
        <ThreadSectionHeader
          count={row.totalCount}
          countTestId="threads-ungrouped-count"
          label="Ungrouped"
          mark={
            <ThreadMarkChip color={null} testId="threads-ungrouped-icon">
              <Folder className="size-3" />
            </ThreadMarkChip>
          }
          muted
          testId="threads-ungrouped-section"
        />
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
  readonly rowsProps: ThreadRowContextProps;
}): ReactElement {
  let content: ReactElement;
  if (row.kind === 'host-child') {
    content = <HostChildSidebarCell row={row} />;
  } else if (row.kind === 'delegated-state') {
    content = <DelegatedSidebarCell row={row} />;
  } else if (row.kind === 'thread') {
    const groupId = rowsProps.folderMode
      ? null
      : (rowsProps.membershipByThreadId.get(row.thread.id) ?? null);
    const pinned = rowsProps.pinnedAtByThreadId[row.thread.id] !== undefined;
    content = (
      <ThreadRow
        draggable={rowsProps.rowsDraggable && !pinned}
        groupId={groupId}
        // Row-local mutation state must never survive a virtual cell changing
        // identity; the key makes that lifetime contract explicit.
        key={row.thread.id}
        moveTargets={rowsProps.moveTargets}
        onDeleteThread={rowsProps.onDeleteThread}
        onMoveThreadToGroup={rowsProps.onMoveThreadToGroup}
        onRenameThread={rowsProps.onRenameThread}
        onSelectThread={rowsProps.onSelectThread}
        onSetThreadPinned={rowsProps.onSetThreadPinned}
        onUpdateThreadAppearance={rowsProps.onUpdateThreadAppearance}
        pinned={pinned}
        selected={rowsProps.selectedThreadId === row.thread.id}
        status={resolveThreadRowStatusState({
          failedUnseen: rowsProps.failedUnseenThreadIds.has(row.thread.id),
          needsYou: rowsProps.needsYouThreadIds.has(row.thread.id),
          running: rowsProps.activeThreadIds.has(row.thread.id),
          unseen: rowsProps.unseenThreadIds.has(row.thread.id),
        })}
        thread={row.thread}
      />
    );
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

  const runAction = (action: (threadIds: readonly string[]) => Promise<void>): void => {
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
  };

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
          className="border-destructive/30 bg-popover text-destructive text-2xs rounded-lg border px-3 py-2 shadow-md"
          role="alert"
        >
          {controller.error}
        </p>
      ) : null}
      {controller.panel === 'move' ? (
        <div className="border-border/80 bg-popover/95 pointer-events-auto ml-auto w-56 rounded-xl border p-2 shadow-lg backdrop-blur-sm">
          <div className="text-muted-foreground text-2xs px-2 pb-1">Move selected to</div>
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
        <div className="border-border/80 bg-popover/95 pointer-events-auto ml-auto w-60 rounded-xl border p-2 shadow-lg backdrop-blur-sm">
          <div className="text-muted-foreground text-2xs px-2 pb-1">Color selected</div>
          <div className="grid gap-2" data-testid="thread-bulk-color-grid">
            {ASSISTANT_THREAD_COLOR_PALETTES.map((palette) => (
              <div key={palette.label}>
                <div className="text-muted-foreground px-1 text-[10px] font-medium tracking-wide uppercase">
                  {palette.label}
                </div>
                <fieldset aria-label={`${palette.label} colors`} className="grid grid-cols-6 gap-1">
                  {palette.colors.map((colorId) => (
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
                </fieldset>
              </div>
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
  failedUnseenThreadIds,
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
  onSetThreadPinned,
  onUpdateThreadAppearance,
  pinnedAtByThreadId,
  selectedThreadId,
  selection,
  threadFiltersActive,
  unseenThreadIds,
  view,
}: {
  readonly activeThreadIds: ReadonlySet<string>;
  readonly failedUnseenThreadIds: ReadonlySet<string>;
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
  readonly onSetThreadPinned: ThreadPinHandler | null;
  readonly onUpdateThreadAppearance: (
    threadId: string,
    patch: AssistantThreadAppearancePatch
  ) => Promise<void>;
  readonly pinnedAtByThreadId: Readonly<Record<string, number>>;
  readonly selectedThreadId: string | undefined;
  readonly selection: ThreadPanelSelection;
  /** Withdraws the row drag affordance — see {@link ThreadRowDragScope}. */
  readonly threadFiltersActive: boolean;
  readonly unseenThreadIds: ReadonlySet<string>;
  readonly view: ThreadListView;
}): ReactElement {
  const folderMode = view.kind === 'folders';
  // Neither a folder nor a date is an order a drag could rewrite.
  const viewOrdered = view.kind === 'folders' || view.kind === 'dates';
  const {
    clearSelection,
    onShowMore: handleShowMore,
    replaceSelection,
    selectGroup,
    selectedThreadIds: selectedAvailableThreadIds,
    visibleRows,
  } = selection;
  // BST-1932: a host thread's children come from the host.
  const hostChildren = useHostChildSidebar(visibleRows.rows);
  const panelRows = hostChildren.rows;
  const nodes = buildThreadPanelTreeNodes(panelRows, hostChildren.hasChildren);
  const expandedGroupIds = new Set([
    ...hostChildren.expandedIds,
    ...visibleRows.rows.flatMap((row) => (row.kind === 'group' && !row.collapsed ? [row.id] : [])),
  ]);
  const bulkSelectionController = useThreadBulkSelectionController({
    onBulkColor,
    onBulkDelete,
    onBulkMove,
    onClearSelection: clearSelection,
    selectedThreadIds: selectedAvailableThreadIds,
  });

  const rowsProps: ThreadRowContextProps = {
    activeThreadIds,
    failedUnseenThreadIds,
    folderMode,
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
    onSetThreadPinned,
    onUpdateThreadAppearance,
    pinnedAtByThreadId,
    rowsDraggable: !(viewOrdered || threadFiltersActive),
    selectedThreadId,
    unseenThreadIds,
  };
  const columns: TreeTableColumn<ThreadPanelVisibleRow>[] = [
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
      indentWidth: 16,
      reserveCheckboxSpace: selection.selecting,
      reserveToggleSpace: true,
      treeControlLineHeight: (node) => getThreadPanelRowHeightPx(node.data.kind),
      treeControlsPosition: 'top',
    },
  ];

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
          if (!selection.selecting) {
            return 'hidden';
          }
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
        onMultiSelectChange={(ids) => replaceSelection(filterThreadPanelSelection(ids, panelRows))}
        onToggleExpand={(nodeId) => {
          const row = panelRows.find((candidate) => candidate.id === nodeId);
          if (row && hostChildren.owns(row)) {
            hostChildren.toggle(row);
            return;
          }
          if (row?.kind !== 'group') {
            return;
          }
          groupHandlers.onToggleGroupCollapsed(getThreadPanelCollapseId(row));
        }}
        // Every row paints its own surface (`THREAD_PANEL_ROW_CLASS_NAME`), so
        // the treegrid row stays bare: no stripe, no fill, no grid.
        rowClassName={(node) =>
          node.data.kind === 'thread'
            ? 'group/thread-tree-row border-0 bg-transparent hover:bg-transparent'
            : 'border-0 bg-transparent hover:bg-transparent'
        }
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
 * drag), and `date` is ordered by activity alone. Exhaustive over
 * ThreadsPanelGroupBy so a future group-by value fails
 * loudly here instead of silently landing on `'grouped'`.
 */
type ThreadPanelSortPresentation = ThreadOrderPresentation | 'date' | 'folder';

function resolveSortPresentation(groupBy: ThreadsPanelGroupBy): ThreadPanelSortPresentation {
  switch (groupBy) {
    case 'none':
      return 'flat';
    case 'custom-groups':
      return 'grouped';
    case 'date':
      return 'date';
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
  failedUnseenThreadIds,
  folderGrouping,
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
  onSetThreadPinned,
  onUpdateThreadAppearance,
  pinnedAtByThreadId,
  selectedThreadId,
  selection,
  threadFiltersActive,
  threads,
  unseenThreadIds,
  view,
}: {
  readonly activeThreadIds: ReadonlySet<string>;
  readonly failedUnseenThreadIds: ReadonlySet<string>;
  readonly folderGrouping: ThreadPanelFolderGroupingState | null;
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
  readonly onSetThreadPinned: ThreadPinHandler | null;
  readonly onUpdateThreadAppearance: (
    threadId: string,
    patch: AssistantThreadAppearancePatch
  ) => Promise<void>;
  readonly pinnedAtByThreadId: Readonly<Record<string, number>>;
  readonly selectedThreadId: string | undefined;
  readonly selection: ThreadPanelSelection;
  readonly threadFiltersActive: boolean;
  readonly threads: readonly AssistantMemoryThread[];
  readonly unseenThreadIds: ReadonlySet<string>;
  readonly view: ThreadListView;
}): ReactElement {
  const contentState = resolveThreadPanelContentState({
    folderGrouping,
    loadState,
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
      failedUnseenThreadIds={failedUnseenThreadIds}
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
      onSetThreadPinned={onSetThreadPinned}
      onUpdateThreadAppearance={onUpdateThreadAppearance}
      pinnedAtByThreadId={pinnedAtByThreadId}
      selectedThreadId={selectedThreadId}
      selection={selection}
      threadFiltersActive={threadFiltersActive}
      unseenThreadIds={unseenThreadIds}
      view={view}
    />
  );
}

/**
 * The panel's header row: the heading, the live disclosed-thread count, and
 * every panel-level control. It renders in the sidebar's header slot, beside
 * the layout's collapse button, so the panel spends no row of its own on it.
 *
 * `treeOnScreen` gates the count and the select-visible toggle. Both describe
 * the treegrid, so when a state card or search results stand in for it they
 * withdraw rather than report a list that is not on screen.
 */
function ThreadsPanelToolbar({
  folderSortBy,
  groupBy,
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
  const selectToggleRef = useRef<HTMLButtonElement>(null);
  const exitSelectionOnEscape = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.defaultPrevented || event.key !== 'Escape' || !selection.selecting) {
      return;
    }
    event.preventDefault();
    selection.setSelecting(false);
    // Leaving selection mode unmounts the select-visible button; keep focus in the toolbar.
    selectToggleRef.current?.focus();
  };
  // One header row: it carries the live visible count and the select-visible
  // toggle too, so no band under the search field holds them.
  //
  // pl-5, not px-3: the search field below is a bordered surface whose box edge
  // sits at 12px but whose first ink — the search icon — sits at 20px. Matching
  // the box edge left the heading looking 8px adrift of everything visible
  // under it, so the heading ink lines up with the icon instead.
  return (
    <div
      className="@container/threads-toolbar flex min-w-0 flex-1 items-center gap-2 pr-1 pl-5"
      data-testid="threads-panel-toolbar"
    >
      <h2 className="min-w-0 truncate text-sm leading-none font-medium">Threads</h2>
      {treeOnScreen ? (
        <span
          className="bg-muted text-muted-foreground text-2xs shrink-0 rounded-full px-1.5 py-0.5 leading-none font-medium tabular-nums @max-[260px]/threads-toolbar:sr-only"
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
        {treeOnScreen && selection.selecting ? (
          <Button
            aria-label={`${selection.allVisibleSelected ? 'Clear' : 'Select'} ${visibleThreadCount} visible ${visibleThreadCount === 1 ? 'thread' : 'threads'}`}
            disabled={visibleThreadCount === 0}
            onClick={selection.toggleVisibleSelection}
            onKeyDown={exitSelectionOnEscape}
            size="icon-xs"
            title={selection.allVisibleSelected ? 'Clear visible' : 'Select visible'}
            type="button"
            variant="ghost"
          >
            <CheckCheck className="size-3.5" />
          </Button>
        ) : null}
        {treeOnScreen ? (
          // A toggle, like Select in mail and chat apps: checkboxes only while
          // it is pressed, and turning it off drops the selection.
          <Button
            aria-label="Select threads"
            aria-pressed={selection.selecting}
            className="aria-pressed:bg-accent aria-pressed:text-accent-foreground"
            data-testid="threads-select-toggle"
            onClick={() => selection.setSelecting(!selection.selecting)}
            onKeyDown={exitSelectionOnEscape}
            ref={selectToggleRef}
            size="icon-xs"
            title={selection.selecting ? 'Done selecting' : 'Select threads'}
            type="button"
            variant="ghost"
          >
            <ListChecks className="size-3.5" />
          </Button>
        ) : null}
        <ThreadsViewOptionsPopover
          folderSortBy={folderSortBy}
          groupBy={groupBy}
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
          className="hover:bg-accent hover:text-accent-foreground ml-1 size-7 px-0 @[360px]/threads-toolbar:w-auto @[360px]/threads-toolbar:gap-1 @[360px]/threads-toolbar:px-2"
          data-testid="new-agent-button"
          disabled={newThreadDisabled}
          onClick={onCreateThread}
          size="xs"
          title={newThreadTitle}
          type="button"
          variant="secondary"
        >
          <Plus className="size-3.5" />
          <span className="hidden @[360px]/threads-toolbar:inline">New Thread</span>
        </Button>
      </div>
    </div>
  );
}

export interface ThreadsPanelSources {
  readonly activeThreads: { readonly error: Error | null; readonly threadIds: ReadonlySet<string> };
  readonly groupsRepository: AssistantThreadGroupsRepository | null;
  readonly host: AssistantThreadHostCapability;
  readonly repository: AssistantThreadCatalogRepository;
  readonly threadsAwaitingApproval: {
    readonly error: Error | null;
    readonly threadIds: ReadonlySet<string>;
  };
}
/**
 * Now, refreshed at each local midnight, so date sections roll over while the
 * panel stays open. Day precision is all the sections read.
 */
function useLocalDay(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const timer = setTimeout(() => setNow(new Date()), nextMidnight.getTime() - Date.now());
    return () => clearTimeout(timer);
  }, [now]);
  return now;
}

export function ThreadsPanelCore({
  host,
  repository,
  groupsRepository,
  activeThreads,
  threadsAwaitingApproval,
}: ThreadsPanelSources): ReactElement {
  const resourceId = WORKSPACE_MEMORY_RESOURCE_ID;
  const selectedThreadByResourceId = useAssistantThreadStore(
    (state) => state.selectedThreadByResourceId
  );
  const threadsByResourceId = useAssistantThreadStore((state) => state.threadsByResourceId);
  const loadStateByResourceId = useAssistantThreadStore((state) => state.loadStateByResourceId);
  const ensureResourceThreads = useAssistantThreadStore((state) => state.ensureResourceThreads);
  const startNewThread = useAssistantThreadStore((state) => state.startNewThread);
  const deleteThread = useAssistantThreadStore((state) => state.deleteThread);
  const deleteThreads = useAssistantThreadStore((state) => state.deleteThreads);
  const renameThread = useAssistantThreadStore((state) => state.renameThread);
  const selectThread = useAssistantThreadStore((state) => state.selectThread);
  const updateThreadAppearance = useAssistantThreadStore((state) => state.updateThreadAppearance);
  const updateThreadsMetadata = useAssistantThreadStore((state) => state.updateThreadsMetadata);
  const selectedThreadId = selectedThreadByResourceId[resourceId];
  const threads = threadsByResourceId[resourceId] ?? EMPTY_THREADS;
  const loadState = loadStateByResourceId[resourceId] ?? { status: 'idle' };
  const groupsByResourceId = useAssistantThreadGroupsStore((state) => state.groupsByResourceId);
  const placementsByThreadId = useAssistantThreadGroupsStore((state) => state.placementsByThreadId);
  const pinnedAtByThreadId = useAssistantThreadGroupsStore((state) => state.pinnedAtByThreadId);
  const setThreadPinned = useAssistantThreadGroupsStore((state) => state.setThreadPinned);
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

  const groups = groupsByResourceId[resourceId] ?? [];
  const groupsLoadState = groupsLoadStateByResourceId[resourceId] ?? { status: 'idle' };
  const placements = Object.values(placementsByThreadId).filter(
    (placement) => placement.resourceId === resourceId
  );
  const sortPresentation = resolveSortPresentation(groupBy);
  const folderGrouping = sortPresentation === 'folder';
  const sortBy = sortPresentation === 'flat' ? flatSortBy : groupedSortBy;

  // The three list-wide run-state projections. ONE live query (or one batched
  // read) per signal, never one per row — and each reports its own failure
  // rather than an empty result that would read as "nothing to report".
  const lastViewedAtByThreadId = useAssistantThreadStore((state) => state.lastViewedAtByThreadId);
  const unseenBaselineAt = useAssistantThreadStore((state) => state.unseenBaselineAt);
  // A list, not a transcript: this panel only READS which thread is on screen
  // (published by the thread strip's workspace) and never advances the viewed
  // watermark — selecting a row here shows the user nothing to have seen.
  const onScreenThreadId = useOnScreenThreadId();
  const unseenThreadIds = useUnseenThreadIds({
    lastViewedAtByThreadId,
    onScreenThreadId,
    threads,
    unseenBaselineAt,
  });

  // Folder grouping's reads (the repositories and the folder names), made only
  // while it shows.
  const folderGroupingReads = useThreadFolderGrouping({ enabled: folderGrouping, threads });
  const folderGroupingState = folderGroupingReads.state;

  const threadFiltersActive = hasActiveThreadFilters(threadFilters);
  const filteredThreads = filterThreadsByThreadFilters({
    filters: threadFilters,
    needsYouThreadIds: threadsAwaitingApproval.threadIds,
    runningThreadIds: activeThreads.threadIds,
    threads,
    unseenThreadIds: unseenThreadIds.unseen,
  });

  const membershipByThreadId = useMemo(
    () => buildThreadMembership({ groups, placements, threads: filteredThreads }),
    [filteredThreads, groups, placements]
  );
  // Recency is conversation activity, read from the live run projection, so a
  // thread that just ran moves up and a rename or a recolor moves nothing.
  const hostRuns = useAssistantThreadHostRuns();
  const ordering: ThreadListOrdering = {
    lastActivityAt: (thread) =>
      getThreadLastActivityAt(thread, hostRuns.get(thread.id) ?? thread.latestRun),
    pinnedAtByThreadId,
  };
  // What waits on the person, across every project: the same projections the
  // rows' glyphs read, over ALL threads, so no filter or grouping hides a wait.
  const needsYouRows = buildThreadNeedsYouRows({
    failedUnseenThreadIds: unseenThreadIds.failedUnseen,
    hostRuns,
    lastActivityAt: ordering.lastActivityAt,
    needsYouThreadIds: threadsAwaitingApproval.threadIds,
    threads,
    unseenThreadIds: unseenThreadIds.unseen,
  });
  const now = useLocalDay();
  // The section builder's input is discriminated on `groupBy`: each grouping
  // takes exactly the inputs it reads, so the modes are separate calls rather
  // than one over-wide argument.
  const view = useMemo(() => {
    if (groupBy === 'folder') {
      return buildThreadListSections({
        folderRowsByRootId: folderGroupingReads.folderRowsByRootId,
        folderSortBy,
        groupBy,
        ordering,
        repositoryByThreadId: mapThreadRepositories(
          filteredThreads,
          folderGroupingReads.repositoryEntries,
          folderGroupingReads.folderRowsByRootId
        ),
        threads: filteredThreads,
      });
    }
    if (groupBy === 'date') {
      return buildThreadListSections({ groupBy, now, ordering, threads: filteredThreads });
    }
    return buildThreadListSections({
      groupBy,
      groups,
      ordering,
      placements,
      sortBy,
      threads: filteredThreads,
    });
  }, [
    filteredThreads,
    folderGroupingReads.folderRowsByRootId,
    folderGroupingReads.repositoryEntries,
    folderSortBy,
    groupBy,
    groups,
    now,
    ordering,
    placements,
    sortBy,
  ]);
  const moveTargets = groups.map((group) => ({ id: group.id, name: group.name }));
  // Disclosure limits + bulk selection live here so the toolbar's count and
  // select-visible toggle read the same state the treegrid renders. FILTERED
  // threads, not all of them: a thread the Show only filters removed is not in
  // the list, so it must not stay in a selection whose action bar the user
  // reads as "these rows".
  const selection = useThreadPanelSelection({ collapsedGroupIds, threads: filteredThreads, view });
  const contentState = resolveThreadPanelContentState({
    folderGrouping: folderGroupingState,
    loadState,
    threadFiltersActive,
    threads: filteredThreads,
    view,
  });

  // Thread text search: debounce and generation gating live in use-thread-search-controller.
  const { retrySearch } = useThreadSearchController({
    resourceId,
    searchHost: host.searchThreads?.bind(host),
  });
  const searchResultTitles = useThreadSearchTitles(resourceId, host);
  const selectSearchResult = useThreadSearchResultNavigation(resourceId, host);
  const searchActive = useThreadSearchStore((state) => state.status !== 'idle');
  // The count and the select-visible toggle describe the treegrid. Withdraw
  // them whenever something else stands in for it — a state card, or search
  // results (whose bulk-selection overlay lives inside the hidden subtree, so a
  // live toggle would select threads the user cannot see or clear).
  const treeOnScreen = contentState.kind === 'tree' && !searchActive;
  const sidebarHeader = useSidebarHeader();
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const nameByGroupId = new Map(groups.map((group) => [group.id, group.name]));
  const groupNameByThreadId = new Map(
    placements.flatMap((placement) => {
      const name = placement.groupId ? nameByGroupId.get(placement.groupId) : undefined;
      return name ? [[placement.threadId, name] as const] : [];
    })
  );

  const handleSelectThread = (threadId: string): void => {
    selectThread(resourceId, threadId);
  };
  const handleRenameThread = async (threadId: string, title: string): Promise<void> => {
    await renameThread(repository, resourceId, threadId, title);
  };
  const handleDeleteThread = async (threadId: string): Promise<void> => {
    await deleteThread(repository, resourceId, threadId);
    // The placement row is inert once the thread is gone; clear it so the
    // placements table does not accumulate orphans.
    if (
      groupsRepository &&
      (placementsByThreadId[threadId] || pinnedAtByThreadId[threadId] !== undefined)
    ) {
      await removeThreadPlacement(groupsRepository, threadId);
    }
  };
  const handleSetThreadPinned = async (threadId: string, pinned: boolean): Promise<void> => {
    if (!groupsRepository) {
      throw new Error('Assistant thread groups database unavailable.');
    }
    await setThreadPinned(groupsRepository, resourceId, threadId, pinned);
  };
  const handleUpdateThreadAppearance = async (
    threadId: string,
    patch: AssistantThreadAppearancePatch
  ): Promise<void> => {
    await updateThreadAppearance(repository, resourceId, threadId, patch);
  };
  const handleBulkColor = async (
    threadIds: readonly string[],
    color: AssistantThreadColorId
  ): Promise<void> => {
    await updateThreadsMetadata(repository, resourceId, threadIds, { color });
  };
  const handleBulkDelete = async (threadIds: readonly string[]): Promise<void> => {
    await deleteThreads(repository, resourceId, threadIds);
    pruneDeletedThreadPlacements(threadIds);
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
  const handleMoveThreadToGroup = async (
    threadId: string,
    groupId: string | null
  ): Promise<void> => {
    if (!groupsRepository) {
      return;
    }
    setGroupActionError(null);
    await moveThreadToGroup(groupsRepository, resourceId, threadId, groupId);
  };
  // Opens the new-thread screen bound to the folder; its first send creates the thread.
  const handleNewThreadInFolder = (folder: ThreadFolderRow): void =>
    startNewThread(resourceId, folder);
  const handleSortByChange = (nextSortBy: ThreadsPanelSortBy): void => {
    if (sortPresentation === 'folder' || sortPresentation === 'date') {
      // Unreachable through the popover, which binds folder mode to
      // `setFolderSortBy` and offers date mode no sort at all. Loud rather than
      // silently writing the grouped sort.
      throw new Error(`${sortPresentation} grouping does not sort through setSortBy.`);
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
      threadFiltersActive,
      view,
    ]
  );
  useThreadsPanelDropMonitor(handlePanelDrop);

  useEffect(() => {
    if (hasFactoryResetPreparationStarted()) {
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
      className="border-border bg-muted/20 @container/threads flex h-full min-h-0 flex-col overflow-hidden border-b"
      data-testid="threads-panel"
    >
      {sidebarHeader
        ? createPortal(
            <ThreadsPanelToolbar
              folderSortBy={folderSortBy}
              groupBy={groupBy}
              newGroupDisabled={!groupsRepository}
              newThreadDisabled={loadState?.status === 'loading'}
              newThreadTitle="Start a new thread in this workspace."
              onClearThreadFilters={clearThreadFilters}
              onCreateGroup={handleCreateGroup}
              onCreateThread={() => startNewThread(resourceId)}
              onFolderSortByChange={setFolderSortBy}
              onGroupByChange={setGroupBy}
              onSortByChange={handleSortByChange}
              onThreadFilterChange={setThreadFilter}
              selection={selection}
              sortBy={sortBy}
              threadFilters={threadFilters}
              treeOnScreen={treeOnScreen}
            />,
            sidebarHeader
          )
        : null}

      <ThreadsPanelSearch
        groupNameByThreadId={groupNameByThreadId}
        onRetry={retrySearch}
        onSelectThread={selectSearchResult}
        threadsById={threadsById}
        titlesByThreadId={searchResultTitles}
      />

      {groupActionError ? (
        <p className="text-destructive text-2xs px-3 pb-2" data-testid="thread-groups-action-error">
          {groupActionError}
        </p>
      ) : null}
      {/* These lines qualify the tree's rows; a state card standing in for the tree already names the failure. */}
      {contentState.kind === 'tree' && groupsLoadState.status === 'error' ? (
        <p className="text-destructive text-2xs px-3 pb-2" data-testid="thread-groups-error-card">
          Failed to load thread groups: {groupsLoadState.error}
        </p>
      ) : null}
      {contentState.kind === 'tree' && activeThreads.error ? (
        <p className="text-destructive text-2xs px-3 pb-2" data-testid="thread-activity-error">
          Active thread status unavailable: {activeThreads.error.message}
        </p>
      ) : null}
      {contentState.kind === 'tree' && folderGroupingReads.repositoriesError ? (
        <p className="text-destructive text-2xs px-3 pb-2" data-testid="thread-repositories-error">
          Repositories unavailable, so each folder is listed on its own:{' '}
          {folderGroupingReads.repositoriesError}
        </p>
      ) : null}
      {contentState.kind === 'tree' && threadsAwaitingApproval.error ? (
        <p className="text-destructive text-2xs px-3 pb-2" data-testid="thread-approvals-error">
          Approval status unavailable: {threadsAwaitingApproval.error.message}
        </p>
      ) : null}

      <div className={searchActive ? 'hidden' : 'flex min-h-0 flex-1 flex-col overflow-hidden'}>
        <ThreadsNeedsYouStrip onSelectThread={handleSelectThread} rows={needsYouRows} />
        <ThreadsPanelContent
          activeThreadIds={activeThreads.threadIds}
          failedUnseenThreadIds={unseenThreadIds.failedUnseen}
          folderGrouping={folderGroupingState}
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
          onNewThreadInFolder={handleNewThreadInFolder}
          onRenameThread={handleRenameThread}
          onSelectThread={handleSelectThread}
          onSetThreadPinned={groupsRepository ? handleSetThreadPinned : null}
          onUpdateThreadAppearance={handleUpdateThreadAppearance}
          pinnedAtByThreadId={pinnedAtByThreadId}
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

export function ThreadsPanel(): ReactElement {
  const host = useAssistantThreadHost();
  if (!host) {
    return <div role="alert">Assistant thread host unavailable</div>;
  }
  return <HostThreadsPanel host={host} />;
}
function HostThreadsPanel({
  host,
}: {
  readonly host: AssistantThreadHostCapability;
}): ReactElement {
  const repository = createHostAssistantThreadRepository(host);
  const capability = getThreadGroupsCapability();
  const groupsRepository = useMemo(
    () => (capability ? createNativeThreadGroupsRepository(capability) : null),
    [capability]
  );
  const runs = useAssistantThreadHostRuns();
  const activeThreads = {
    error: null,
    threadIds: new Set([...runs].filter(([, run]) => run.status === 'running').map(([id]) => id)),
  };
  const threadsAwaitingApproval = {
    error: null,
    threadIds: new Set([...runs].filter(([, run]) => run.needsInput).map(([id]) => id)),
  };
  if (!groupsRepository) {
    return <div role="alert">Thread groups capability unavailable</div>;
  }
  return (
    <ThreadsPanelCore
      activeThreads={activeThreads}
      groupsRepository={groupsRepository}
      host={host}
      repository={repository}
      threadsAwaitingApproval={threadsAwaitingApproval}
    />
  );
}
