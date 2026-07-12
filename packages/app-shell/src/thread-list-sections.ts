import type { AssistantMemoryThread } from './assistant-memory-repository';
import type {
  AssistantThreadGroup,
  AssistantThreadPlacement,
} from './assistant-thread-groups-repository';

export type ThreadsPanelGroupBy = 'custom-groups' | 'none';
export type ThreadsPanelSortBy = 'custom' | 'name' | 'recency';

export interface ThreadListSection {
  readonly group: AssistantThreadGroup;
  readonly threads: readonly AssistantMemoryThread[];
}

export type ThreadListView =
  | { readonly kind: 'flat'; readonly threads: readonly AssistantMemoryThread[] }
  | {
      readonly kind: 'grouped';
      readonly sections: readonly ThreadListSection[];
      readonly ungrouped: readonly AssistantMemoryThread[];
    };

function compareByRecency(left: AssistantMemoryThread, right: AssistantMemoryThread): number {
  const byUpdatedAt = right.updatedAt.getTime() - left.updatedAt.getTime();
  return byUpdatedAt === 0 ? left.id.localeCompare(right.id) : byUpdatedAt;
}

function compareByName(left: AssistantMemoryThread, right: AssistantMemoryThread): number {
  const byTitle = left.title.localeCompare(right.title, undefined, { sensitivity: 'base' });
  return byTitle === 0 ? left.id.localeCompare(right.id) : byTitle;
}

function sortSection(
  threads: readonly AssistantMemoryThread[],
  sortBy: ThreadsPanelSortBy,
  rankByThreadId: ReadonlyMap<string, string>
): AssistantMemoryThread[] {
  if (sortBy === 'name') {
    return [...threads].sort(compareByName);
  }
  if (sortBy === 'custom') {
    // Unranked threads (typically brand-new) surface first by recency so they
    // are never lost at the bottom; ranked threads follow in manual order.
    const unranked = threads.filter((thread) => !rankByThreadId.has(thread.id));
    const ranked = threads.filter((thread) => rankByThreadId.has(thread.id));
    unranked.sort(compareByRecency);
    ranked.sort((left, right) => {
      const leftRank = rankByThreadId.get(left.id) ?? '';
      const rightRank = rankByThreadId.get(right.id) ?? '';
      return leftRank < rightRank ? -1 : leftRank > rightRank ? 1 : left.id.localeCompare(right.id);
    });
    return [...unranked, ...ranked];
  }
  return [...threads].sort(compareByRecency);
}

/**
 * Pure grouping/sorting core for the Threads panel. Placements referencing
 * unknown threads are ignored; placements referencing deleted groups fall back
 * to Ungrouped. Groups are ordered by their fractional rank; the Ungrouped
 * section always renders last (after every group).
 */
export function buildThreadListSections({
  groupBy,
  groups,
  placements,
  sortBy,
  threads,
}: {
  readonly groupBy: ThreadsPanelGroupBy;
  readonly groups: readonly AssistantThreadGroup[];
  readonly placements: readonly AssistantThreadPlacement[];
  readonly sortBy: ThreadsPanelSortBy;
  readonly threads: readonly AssistantMemoryThread[];
}): ThreadListView {
  const threadIds = new Set(threads.map((thread) => thread.id));
  const livePlacements = placements.filter((placement) => threadIds.has(placement.threadId));
  const rankByThreadId = new Map(
    livePlacements.map((placement) => [placement.threadId, placement.rank])
  );

  if (groupBy === 'none' || groups.length === 0) {
    return { kind: 'flat', threads: sortSection(threads, sortBy, rankByThreadId) };
  }

  const groupIds = new Set(groups.map((group) => group.id));
  const groupIdByThreadId = new Map(
    livePlacements
      .filter((placement) => placement.groupId !== null && groupIds.has(placement.groupId))
      .map((placement) => [placement.threadId, placement.groupId as string])
  );

  const orderedGroups = [...groups].sort((left, right) =>
    left.rank < right.rank ? -1 : left.rank > right.rank ? 1 : left.id.localeCompare(right.id)
  );
  const sections = orderedGroups.map((group) => ({
    group,
    threads: sortSection(
      threads.filter((thread) => groupIdByThreadId.get(thread.id) === group.id),
      sortBy,
      rankByThreadId
    ),
  }));
  const ungrouped = sortSection(
    threads.filter((thread) => !groupIdByThreadId.has(thread.id)),
    sortBy,
    rankByThreadId
  );
  return { kind: 'grouped', sections, ungrouped };
}
