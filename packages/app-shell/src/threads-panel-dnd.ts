import type { ThreadListView, ThreadOrderEntry } from '@brainstrike/assistant-data';

/**
 * Drop resolution for the Threads panel drag and drop. Pragmatic drag and drop
 * delivers plain source/target data records; this pure function turns them
 * into a single intent the panel maps onto store actions. Keeping it pure
 * means the whole drop matrix is unit-testable without pointer simulation.
 */
export type ThreadsPanelDragSource =
  | { readonly groupId: string | null; readonly threadId: string; readonly type: 'thread-row' }
  | { readonly groupId: string; readonly type: 'group-header' };

export type ThreadsPanelDropTarget =
  | {
      readonly edge: 'bottom' | 'top';
      readonly groupId: string | null;
      readonly threadId: string;
      readonly type: 'thread-row';
    }
  | {
      readonly edge?: 'bottom' | 'top';
      readonly groupId: string;
      readonly type: 'group-header';
    }
  | { readonly type: 'ungrouped-section' };

export type ThreadsPanelDropIntent =
  | { readonly kind: 'none' }
  | {
      readonly groupId: string | null;
      readonly kind: 'move-thread-to-group';
      readonly threadId: string;
    }
  | {
      readonly kind: 'apply-thread-order';
      readonly orderedEntries: readonly ThreadOrderEntry[];
    }
  | { readonly kind: 'reorder-groups'; readonly orderedGroupIds: readonly string[] };

const NONE: ThreadsPanelDropIntent = { kind: 'none' };

function sectionThreadIds(view: ThreadListView, groupId: string | null): readonly string[] {
  if (view.kind === 'flat') {
    return view.threads.map((thread) => thread.id);
  }
  if (view.kind === 'folders') {
    // Unreachable: `resolveThreadsPanelDrop` answers `none` for a folders view
    // before any resolver runs. Kept as an invariant so a future caller that
    // reaches in here cannot invent an order folder sections do not have.
    throw new Error('resolveThreadsPanelDrop: folder grouping has no drag order.');
  }
  if (groupId === null) {
    return view.ungrouped.map((thread) => thread.id);
  }
  const section = view.sections.find((candidate) => candidate.header.group.id === groupId);
  return section ? section.threads.map((thread) => thread.id) : [];
}

function resolveThreadOnThreadDrop({
  groupIdByThreadId,
  source,
  target,
  view,
}: {
  readonly groupIdByThreadId: ReadonlyMap<string, string | null>;
  readonly source: Extract<ThreadsPanelDragSource, { type: 'thread-row' }>;
  readonly target: Extract<ThreadsPanelDropTarget, { type: 'thread-row' }>;
  readonly view: ThreadListView;
}): ThreadsPanelDropIntent {
  if (source.threadId === target.threadId) {
    return NONE;
  }
  const destinationGroupId = view.kind === 'flat' ? null : target.groupId;
  const currentIds = sectionThreadIds(
    view,
    view.kind === 'flat' ? null : destinationGroupId
  ).filter((threadId) => threadId !== source.threadId);
  const targetIndex = currentIds.indexOf(target.threadId);
  if (targetIndex === -1) {
    return NONE;
  }
  const insertIndex = target.edge === 'top' ? targetIndex : targetIndex + 1;
  const orderedIds = [
    ...currentIds.slice(0, insertIndex),
    source.threadId,
    ...currentIds.slice(insertIndex),
  ];

  const previousIds = sectionThreadIds(view, view.kind === 'flat' ? null : destinationGroupId);
  const sameSection = view.kind === 'flat' || source.groupId === destinationGroupId;
  if (sameSection && orderedIds.join('\0') === previousIds.join('\0')) {
    return NONE;
  }

  const orderedEntries = orderedIds.map((threadId) => ({
    // Flat mode reorders without changing membership; grouped mode adopts the
    // destination section's group for every listed thread (a section rewrite).
    groupId:
      view.kind === 'flat'
        ? threadId === source.threadId
          ? source.groupId
          : (groupIdByThreadId.get(threadId) ?? null)
        : destinationGroupId,
    threadId,
  }));
  return { kind: 'apply-thread-order', orderedEntries };
}

function resolveGroupReorder({
  source,
  target,
  view,
}: {
  readonly source: Extract<ThreadsPanelDragSource, { type: 'group-header' }>;
  readonly target: Extract<ThreadsPanelDropTarget, { type: 'group-header' }>;
  readonly view: ThreadListView;
}): ThreadsPanelDropIntent {
  if (view.kind !== 'grouped' || !target.edge || source.groupId === target.groupId) {
    return NONE;
  }
  // One pass collects both the rendered order and the order with the dragged
  // group lifted out; the two are compared at the end to detect a no-op drop.
  const previousIds: string[] = [];
  const currentIds: string[] = [];
  for (const section of view.sections) {
    const groupId = section.header.group.id;
    previousIds.push(groupId);
    if (groupId !== source.groupId) {
      currentIds.push(groupId);
    }
  }
  const targetIndex = currentIds.indexOf(target.groupId);
  if (targetIndex === -1) {
    return NONE;
  }
  const insertIndex = target.edge === 'top' ? targetIndex : targetIndex + 1;
  const orderedGroupIds = [
    ...currentIds.slice(0, insertIndex),
    source.groupId,
    ...currentIds.slice(insertIndex),
  ];
  if (orderedGroupIds.join('\0') === previousIds.join('\0')) {
    return NONE;
  }
  return { kind: 'reorder-groups', orderedGroupIds };
}

export function resolveThreadsPanelDrop({
  filtersActive,
  groupIdByThreadId,
  source,
  target,
  view,
}: {
  /**
   * True while at least one "Show only" filter is narrowing the list, which
   * makes every rendered section PARTIAL. See the row short-circuit below.
   */
  readonly filtersActive: boolean;
  readonly groupIdByThreadId: ReadonlyMap<string, string | null>;
  readonly source: ThreadsPanelDragSource;
  readonly target: ThreadsPanelDropTarget;
  readonly view: ThreadListView;
}): ThreadsPanelDropIntent {
  if (view.kind === 'folders') {
    // Folder sections have no manual order and no membership to rewrite: a
    // thread's folder is its `metadata.operatingRootId`, re-bound from the
    // composer's folder chip. The panel therefore renders no drag sources in
    // this mode, but the drop monitor is global — so a drop that arrives from
    // somewhere else resolves to no intent rather than throwing at the user.
    return NONE;
  }
  if (filtersActive && source.type === 'thread-row') {
    // A filtered section is a PARTIAL section, and `applyThreadOrder` rewrites
    // the ranks of everything it is handed with ONE fresh key sequence — its
    // "manual order is always fully materialized" only holds when the entries
    // are the WHOLE section. Reordering what the filter left visible would
    // renumber those threads while the hidden ones keep their old ranks, so
    // clearing the filter would reveal the two sequences interleaved: an order
    // the user never chose, with nothing anywhere reporting it. The panel
    // therefore renders no row drag source while a filter is active — the same
    // "no affordance beats one that lies" call folder grouping makes — and
    // this mirrors it for the global drop monitor. Group-header drags are
    // untouched: a section is minted per GROUP, not per surviving thread, so a
    // group reorder is still a complete rewrite.
    return NONE;
  }
  if (source.type === 'thread-row') {
    if (target.type === 'group-header') {
      if (source.groupId === target.groupId) {
        return NONE;
      }
      return { groupId: target.groupId, kind: 'move-thread-to-group', threadId: source.threadId };
    }
    if (target.type === 'ungrouped-section') {
      if (source.groupId === null) {
        return NONE;
      }
      return { groupId: null, kind: 'move-thread-to-group', threadId: source.threadId };
    }
    return resolveThreadOnThreadDrop({ groupIdByThreadId, source, target, view });
  }
  if (target.type === 'group-header') {
    return resolveGroupReorder({ source, target, view });
  }
  return NONE;
}
