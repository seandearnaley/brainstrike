import type { AssistantMemoryThread } from './assistant-memory-repository';
import type { AssistantThreadGroup } from './assistant-thread-groups-repository';
import type { ThreadListView } from './thread-list-sections';

export const THREAD_PANEL_INITIAL_VISIBLE_LIMIT = 50;
export const THREAD_PANEL_DISCLOSURE_INCREMENT = 50;

export type ThreadPanelSectionKey = 'flat' | 'ungrouped' | `group:${string}`;

export type ThreadPanelVisibleRow =
  | {
      readonly collapsed: boolean;
      readonly group: AssistantThreadGroup | null;
      readonly id: `group:${string}`;
      readonly kind: 'group';
      readonly sectionKey: Exclude<ThreadPanelSectionKey, 'flat'>;
      readonly totalCount: number;
    }
  | {
      readonly groupId: string | null;
      readonly id: string;
      readonly kind: 'thread';
      readonly parentId: `group:${string}` | null;
      readonly thread: AssistantMemoryThread;
    }
  | {
      readonly groupId: string | null;
      readonly id: `show-more:${string}`;
      readonly kind: 'show-more';
      readonly parentId: `group:${string}` | null;
      readonly remainingCount: number;
      readonly sectionKey: ThreadPanelSectionKey;
    }
  | {
      readonly groupId: string | null;
      readonly id: `empty:${string}`;
      readonly kind: 'empty';
      readonly parentId: `group:${string}`;
      readonly sectionKey: Exclude<ThreadPanelSectionKey, 'flat'>;
    };

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
  readonly parentId: `group:${string}` | null;
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
  const parentId = group ? (`group:${group.id}` as const) : ('group:ungrouped' as const);
  rows.push({
    collapsed,
    group,
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

  for (const section of view.sections) {
    appendGroupedSection({
      collapsed: Boolean(collapsedGroupIds[section.group.id]),
      group: section.group,
      limitsBySectionKey,
      rows,
      threads: section.threads,
      visibleThreadIds,
    });
  }
  appendGroupedSection({
    collapsed: false,
    group: null,
    limitsBySectionKey,
    rows,
    threads: view.ungrouped,
    visibleThreadIds,
  });
  return { rows, visibleThreadIds };
}
