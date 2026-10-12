import type {
  AssistantMemoryThread,
  AssistantThreadGroup,
  ThreadListSectionHeader,
  ThreadListView,
} from '@brainstrike/assistant-data';
import { UNASSIGNED_FOLDER_SECTION_ID } from '@brainstrike/assistant-data';
import { THREAD_CONTROL_ROW_PITCH_PX } from './assistant-thread-presentation';
import type { DelegatedSidebarRow } from './delegated-sidebar-rows';

export const THREAD_PANEL_INITIAL_VISIBLE_LIMIT = 50;
export const THREAD_PANEL_DISCLOSURE_INCREMENT = 50;
export const THREAD_PANEL_UNGROUPED_NODE_ID = 'group:ungrouped' as const;

/**
 * Treegrid node id of a section row. Custom-groups sections keep their
 * `group:` prefix (the Ungrouped section is {@link THREAD_PANEL_UNGROUPED_NODE_ID});
 * folder sections reuse the section ids `thread-list-sections.ts` mints, so one
 * id addresses the row, its disclosure limit, its collapse state, and its
 * membership.
 */
export type ThreadPanelSectionNodeId =
  | typeof UNASSIGNED_FOLDER_SECTION_ID
  | `folder:${string}`
  | `group:${string}`;

export type ThreadPanelSectionKey = 'flat' | 'ungrouped' | ThreadPanelSectionNodeId;

/**
 * The custom-groups Ungrouped section is NOT the folder view's "No folder"
 * section: one is the absence of a user-created group, the other the absence of
 * a workspace folder, and they carry different headers and actions.
 */
export type ThreadPanelSectionHeader = ThreadListSectionHeader | { readonly kind: 'ungrouped' };

export interface ThreadPanelGroupRow {
  readonly collapsed: boolean;
  readonly header: ThreadPanelSectionHeader;
  readonly id: ThreadPanelSectionNodeId;
  readonly kind: 'group';
  readonly sectionKey: Exclude<ThreadPanelSectionKey, 'flat'>;
  readonly totalCount: number;
}

export type ThreadPanelVisibleRow =
  | DelegatedSidebarRow
  | ThreadPanelGroupRow
  | {
      readonly groupId: string | null;
      readonly id: string;
      readonly kind: 'thread';
      readonly parentId: ThreadPanelSectionNodeId | null;
      readonly thread: AssistantMemoryThread;
    }
  | {
      readonly groupId: string | null;
      readonly id: `show-more:${string}`;
      readonly kind: 'show-more';
      readonly parentId: ThreadPanelSectionNodeId | null;
      readonly remainingCount: number;
      readonly sectionKey: ThreadPanelSectionKey;
    }
  | {
      readonly groupId: string | null;
      readonly id: `empty:${string}`;
      readonly kind: 'empty';
      readonly parentId: ThreadPanelSectionNodeId;
      readonly sectionKey: Exclude<ThreadPanelSectionKey, 'flat'>;
    };

/**
 * Address of the section's members for `getGroupMemberIds`. `null` is the
 * custom-groups Ungrouped section, which has no section id of its own.
 */
export function getThreadPanelMemberSectionId(row: ThreadPanelGroupRow): string | null {
  switch (row.header.kind) {
    case 'group':
      return row.header.group.id;
    case 'ungrouped':
      return null;
    case 'folder':
    case 'unassigned':
      return row.id;
    default: {
      const exhaustive: never = row.header;
      throw new Error(`Unknown thread panel section header: ${JSON.stringify(exhaustive)}.`);
    }
  }
}

/** Key this section's collapsed flag is stored under in `collapsedGroupIds`. */
export function getThreadPanelCollapseId(row: ThreadPanelGroupRow): string {
  switch (row.header.kind) {
    case 'group':
      return row.header.group.id;
    case 'ungrouped':
      return THREAD_PANEL_UNGROUPED_NODE_ID;
    case 'folder':
    case 'unassigned':
      return row.id;
    default: {
      const exhaustive: never = row.header;
      throw new Error(`Unknown thread panel section header: ${JSON.stringify(exhaustive)}.`);
    }
  }
}

/**
 * Pre-measurement height estimate per row kind, in px. TreeTable re-measures
 * after mount, so these only govern first-paint scrollbar length and
 * `scrollToIndex` accuracy into an unmeasured region — but one blanket estimate
 * gets three of the four kinds wrong, and the error scales with group count.
 *
 * Measured in the running renderer, not derived from the Tailwind classes:
 * group header 40, drop-zone/empty 40, show-more 36, thread 28 + 2px margin
 * either side — the same values at 303.5px and 218.5px panel width. The empty
 * and show-more rows carry text that can wrap at extreme widths, so those two
 * are their unwrapped min-height; re-measurement corrects the rest.
 */
const THREAD_PANEL_ROW_HEIGHT_PX = {
  'delegated-state': 36,
  empty: 40,
  group: 40,
  'host-child': THREAD_CONTROL_ROW_PITCH_PX,
  'show-more': 36,
  thread: THREAD_CONTROL_ROW_PITCH_PX,
} as const satisfies Record<ThreadPanelVisibleRow['kind'], number>;

export function getThreadPanelRowHeightPx(kind: ThreadPanelVisibleRow['kind']): number {
  return THREAD_PANEL_ROW_HEIGHT_PX[kind];
}

export interface ThreadPanelVisibleRowsResult {
  readonly rows: readonly ThreadPanelVisibleRow[];
  readonly visibleThreadIds: readonly string[];
}

function requireVisibleLimit(value: number | undefined, sectionKey: ThreadPanelSectionKey): number {
  if (value === undefined) {
    return THREAD_PANEL_INITIAL_VISIBLE_LIMIT;
  }
  if (!(Number.isSafeInteger(value) && value >= 0)) {
    throw new Error(`Invalid thread disclosure limit for ${sectionKey}: ${String(value)}.`);
  }
  return value;
}

function appendSectionRows({
  groupId,
  limitsBySectionKey,
  parentId,
  rows,
  sectionKey,
  threads,
  visibleThreadIds,
}: {
  readonly groupId: string | null;
  readonly limitsBySectionKey: Readonly<Record<string, number>>;
  readonly parentId: ThreadPanelSectionNodeId | null;
  readonly rows: ThreadPanelVisibleRow[];
  readonly sectionKey: ThreadPanelSectionKey;
  readonly threads: readonly AssistantMemoryThread[];
  readonly visibleThreadIds: string[];
}): void {
  const limit = requireVisibleLimit(limitsBySectionKey[sectionKey], sectionKey);
  const visibleThreads = threads.slice(0, limit);
  for (const thread of visibleThreads) {
    rows.push({ groupId, id: thread.id, kind: 'thread', parentId, thread });
    visibleThreadIds.push(thread.id);
  }
  const remainingCount = threads.length - visibleThreads.length;
  if (remainingCount > 0) {
    const id: `show-more:${string}` = `show-more:${sectionKey}`;
    rows.push({
      groupId,
      id,
      kind: 'show-more',
      parentId,
      remainingCount,
      sectionKey,
    });
  }
}

function appendGroupedSection({
  collapsed,
  group,
  limitsBySectionKey,
  rows,
  threads,
  visibleThreadIds,
}: {
  readonly collapsed: boolean;
  readonly group: AssistantThreadGroup | null;
  readonly limitsBySectionKey: Readonly<Record<string, number>>;
  readonly rows: ThreadPanelVisibleRow[];
  readonly threads: readonly AssistantMemoryThread[];
  readonly visibleThreadIds: string[];
}): void {
  const sectionKey = group ? (`group:${group.id}` as const) : ('ungrouped' as const);
  const parentId = group ? (`group:${group.id}` as const) : THREAD_PANEL_UNGROUPED_NODE_ID;
  rows.push({
    collapsed,
    header: group ? { group, kind: 'group' } : { kind: 'ungrouped' },
    id: parentId,
    kind: 'group',
    sectionKey,
    totalCount: threads.length,
  });
  if (collapsed) {
    return;
  }
  if (threads.length === 0) {
    const id: `empty:${string}` = `empty:${sectionKey}`;
    rows.push({
      groupId: group?.id ?? null,
      id,
      kind: 'empty',
      parentId,
      sectionKey,
    });
    return;
  }
  appendSectionRows({
    groupId: group?.id ?? null,
    limitsBySectionKey,
    parentId,
    rows,
    sectionKey,
    threads,
    visibleThreadIds,
  });
}

/**
 * Re-derives the section id as a node id WITHOUT a cast, so a section id this
 * module cannot address fails loudly here instead of silently becoming an
 * unreachable treegrid node. The two shapes are the ones
 * `thread-list-sections.ts` mints (`folder:${rootId}` and the deliberately
 * unemittable `folder-unassigned` sentinel).
 */
function requireFolderSectionNodeId(
  sectionId: string
): typeof UNASSIGNED_FOLDER_SECTION_ID | `folder:${string}` {
  if (sectionId === UNASSIGNED_FOLDER_SECTION_ID) {
    return UNASSIGNED_FOLDER_SECTION_ID;
  }
  const prefix = 'folder:';
  if (sectionId.startsWith(prefix)) {
    return `folder:${sectionId.slice(prefix.length)}`;
  }
  throw new Error(`Unknown thread folder section id: ${sectionId}.`);
}

/**
 * A folder section never renders the empty drop-zone row a custom group does:
 * `buildThreadListSections` only creates a bucket for folders that HAVE
 * threads, and a folder is not a drop target (re-binding happens through the
 * composer's folder chip, not a drag).
 */
function appendFolderSection({
  collapsed,
  header,
  limitsBySectionKey,
  nodeId,
  rows,
  threads,
  visibleThreadIds,
}: {
  readonly collapsed: boolean;
  readonly header: ThreadPanelSectionHeader;
  readonly limitsBySectionKey: Readonly<Record<string, number>>;
  readonly nodeId: typeof UNASSIGNED_FOLDER_SECTION_ID | `folder:${string}`;
  readonly rows: ThreadPanelVisibleRow[];
  readonly threads: readonly AssistantMemoryThread[];
  readonly visibleThreadIds: string[];
}): void {
  rows.push({
    collapsed,
    header,
    id: nodeId,
    kind: 'group',
    sectionKey: nodeId,
    totalCount: threads.length,
  });
  if (collapsed) {
    return;
  }
  appendSectionRows({
    groupId: null,
    limitsBySectionKey,
    parentId: nodeId,
    rows,
    sectionKey: nodeId,
    threads,
    visibleThreadIds,
  });
}

export function buildThreadPanelVisibleRows({
  collapsedGroupIds,
  limitsBySectionKey,
  view,
}: {
  readonly collapsedGroupIds: Readonly<Record<string, true>>;
  readonly limitsBySectionKey: Readonly<Record<string, number>>;
  readonly view: ThreadListView;
}): ThreadPanelVisibleRowsResult {
  const rows: ThreadPanelVisibleRow[] = [];
  const visibleThreadIds: string[] = [];
  if (view.kind === 'flat') {
    appendSectionRows({
      groupId: null,
      limitsBySectionKey,
      parentId: null,
      rows,
      sectionKey: 'flat',
      threads: view.threads,
      visibleThreadIds,
    });
    return { rows, visibleThreadIds };
  }
  if (view.kind === 'folders') {
    for (const section of view.sections) {
      const nodeId = requireFolderSectionNodeId(section.id);
      appendFolderSection({
        collapsed: Boolean(collapsedGroupIds[nodeId]),
        header: section.header,
        limitsBySectionKey,
        nodeId,
        rows,
        threads: section.threads,
        visibleThreadIds,
      });
    }
    return { rows, visibleThreadIds };
  }

  for (const section of view.sections) {
    appendGroupedSection({
      collapsed: Boolean(collapsedGroupIds[section.header.group.id]),
      group: section.header.group,
      limitsBySectionKey,
      rows,
      threads: section.threads,
      visibleThreadIds,
    });
  }
  appendGroupedSection({
    collapsed: Boolean(collapsedGroupIds[THREAD_PANEL_UNGROUPED_NODE_ID]),
    group: null,
    limitsBySectionKey,
    rows,
    threads: view.ungrouped,
    visibleThreadIds,
  });
  return { rows, visibleThreadIds };
}

/** Root bulk selection survives filtering/collapse; delegated rows are inspection targets. */
export function filterThreadPanelSelection(
  ids: ReadonlySet<string>,
  rows: readonly ThreadPanelVisibleRow[]
): Set<string> {
  const delegatedIds = new Set(
    rows.flatMap((row) =>
      row.kind === 'delegated-state' || row.kind === 'host-child' ? [row.id] : []
    )
  );
  return new Set([...ids].filter((id) => !delegatedIds.has(id)));
}
