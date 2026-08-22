import type { AssistantMemoryThread } from './assistant-memory-repository';
import type {
  AssistantThreadGroup,
  AssistantThreadPlacement,
} from './assistant-thread-groups-repository';

export type ThreadsPanelGroupBy = 'custom-groups' | 'folder' | 'none';
export type ThreadsPanelSortBy = 'custom' | 'name' | 'recency';
/** Folder sections have no manual order, so `custom` is not offered there. */
export type ThreadsPanelFolderSortBy = 'name' | 'recency';

/**
 * Display facts for ONE workspace folder, resolved from the `roots` table by
 * the caller (this package stays DB-free). `rootId` is the durable `roots.id`
 * a thread's `metadata.operatingRootId` points at.
 */
export interface ThreadFolderRow {
  readonly displayName: string;
  readonly path: string | null;
  readonly rootId: string;
}

/** A user-created group section (custom-groups mode). */
export interface ThreadListGroupHeader {
  readonly group: AssistantThreadGroup;
  readonly kind: 'group';
}
/** A workspace-folder section (folder mode). */
export interface ThreadListFolderHeader {
  readonly folder: ThreadFolderRow;
  readonly kind: 'folder';
}
/** The trailing "No folder" section (folder mode only). */
export interface ThreadListUnassignedHeader {
  readonly kind: 'unassigned';
}
export type ThreadListSectionHeader =
  | ThreadListFolderHeader
  | ThreadListGroupHeader
  | ThreadListUnassignedHeader;

interface ThreadListSectionBase {
  readonly id: string;
  readonly threads: readonly AssistantMemoryThread[];
}
/** `id` is the group id, so grouped section ids stay drag/drop identities. */
export interface ThreadListGroupSection extends ThreadListSectionBase {
  readonly header: ThreadListGroupHeader;
}
/** `id` is `folder:${rootId}` or `folder-unassigned`. */
export interface ThreadListFolderSection extends ThreadListSectionBase {
  readonly header: ThreadListFolderHeader | ThreadListUnassignedHeader;
}
export type ThreadListSection = ThreadListFolderSection | ThreadListGroupSection;

export type ThreadListView =
  | { readonly kind: 'flat'; readonly threads: readonly AssistantMemoryThread[] }
  | {
      readonly kind: 'grouped';
      readonly sections: readonly ThreadListGroupSection[];
      readonly ungrouped: readonly AssistantMemoryThread[];
    }
  | { readonly kind: 'folders'; readonly sections: readonly ThreadListFolderSection[] };

/**
 * Section id of the trailing "No folder" bucket in folder mode. Deliberately
 * NOT of the form `folder:${rootId}` (a hyphen, not the colon `folderSectionId`
 * uses) so no root id — including one literally named "unassigned" — can ever
 * produce this id via `folderSectionId` and collide with the sentinel.
 */
export const UNASSIGNED_FOLDER_SECTION_ID = 'folder-unassigned';

/**
 * The prefix every root-bound folder section id carries. Exported so the one
 * place that has to RECOGNIZE such an id without a root id in hand — the
 * collapse-key prune in `assistant-thread-groups-store.ts` — reads it from here
 * instead of re-spelling the literal.
 */
export const FOLDER_SECTION_ID_PREFIX = 'folder:';

/** Section id for a folder section bound to `rootId`. */
export function folderSectionId(rootId: string): string {
  return `${FOLDER_SECTION_ID_PREFIX}${rootId}`;
}

const EMPTY_THREAD_IDS: readonly string[] = Object.freeze([]);
interface GroupMemberIdsCache {
  readonly memberIdsBySectionId: Map<string | null, readonly string[]>;
  readonly threadsBySectionId: ReadonlyMap<string, readonly AssistantMemoryThread[]>;
}

const groupMemberIdsByView = new WeakMap<ThreadListView, GroupMemberIdsCache>();

/**
 * The thread's primary workspace folder: the durable `roots.id` W1 writes into
 * `metadata.operatingRootId`. A missing or blank id means "No folder" - the
 * display-only `operatingRootDisplayName`/`operatingRootPath` are never a
 * fallback identity.
 */
export function getThreadPrimaryRootId(thread: AssistantMemoryThread): string | null {
  const rootId = thread.metadata?.operatingRootId;
  if (!rootId) {
    return null;
  }
  return rootId;
}

function projectThreadIds(threads: readonly AssistantMemoryThread[]): readonly string[] {
  return threads.length === 0 ? EMPTY_THREAD_IDS : threads.map((thread) => thread.id);
}

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

function compareFolderRows(left: ThreadFolderRow, right: ThreadFolderRow): number {
  const byDisplayName = left.displayName.localeCompare(right.displayName, undefined, {
    sensitivity: 'base',
  });
  return byDisplayName === 0 ? left.rootId.localeCompare(right.rootId) : byDisplayName;
}

/** One folder's threads plus the row that opened the bucket. */
interface FolderBucket {
  readonly folder: ThreadFolderRow;
  readonly threads: AssistantMemoryThread[];
}

/**
 * Folder sections for the Threads panel: one section per resolved workspace
 * folder (alphabetical by display name), with a trailing "No folder" section
 * for threads whose primary root is missing, blank, or has no display row.
 * An unresolved root id is NOT an error here - the builder stays pure and the
 * calling hook logs it.
 */
function buildFolderSections({
  folderRowsByRootId,
  folderSortBy,
  threads,
}: BuildThreadListSectionsFolderInput): ThreadListFolderSection[] {
  // The bucket carries the row that opened it, so the section pass never has to
  // look the row up a second time (a lookup that could only ever succeed).
  const bucketsByRootId = new Map<string, FolderBucket>();
  const unassignedThreads: AssistantMemoryThread[] = [];
  for (const thread of threads) {
    const rootId = getThreadPrimaryRootId(thread);
    const folder = rootId === null ? undefined : folderRowsByRootId.get(rootId);
    if (folder === undefined) {
      unassignedThreads.push(thread);
      continue;
    }
    const bucket = bucketsByRootId.get(folder.rootId);
    if (bucket === undefined) {
      bucketsByRootId.set(folder.rootId, { folder, threads: [thread] });
      continue;
    }
    bucket.threads.push(thread);
  }

  const compareThreads = folderSortBy === 'name' ? compareByName : compareByRecency;
  const sections: ThreadListFolderSection[] = [...bucketsByRootId.values()]
    .map((bucket) => ({
      header: { folder: bucket.folder, kind: 'folder' as const },
      id: folderSectionId(bucket.folder.rootId),
      threads: bucket.threads.sort(compareThreads),
    }))
    .sort((left, right) => compareFolderRows(left.header.folder, right.header.folder));
  if (unassignedThreads.length > 0) {
    sections.push({
      header: { kind: 'unassigned' },
      id: UNASSIGNED_FOLDER_SECTION_ID,
      threads: [...unassignedThreads].sort(compareThreads),
    });
  }
  return sections;
}

/**
 * Effective group membership for every loaded thread: the placement's group id
 * when that group still exists, otherwise null (Ungrouped). The panel's drag
 * sources and the section builder below both read membership from here so the
 * two can never disagree.
 */
export function buildThreadMembership({
  groups,
  placements,
  threads,
}: {
  readonly groups: readonly AssistantThreadGroup[];
  readonly placements: readonly AssistantThreadPlacement[];
  readonly threads: readonly AssistantMemoryThread[];
}): ReadonlyMap<string, string | null> {
  const groupIds = new Set(groups.map((group) => group.id));
  const placementByThreadId = new Map(
    placements.map((placement) => [placement.threadId, placement])
  );
  return new Map(
    threads.map((thread) => {
      const groupId = placementByThreadId.get(thread.id)?.groupId ?? null;
      return [thread.id, groupId !== null && groupIds.has(groupId) ? groupId : null];
    })
  );
}

/**
 * Folder grouping's inputs. It ignores groups, placements, and `sortBy`
 * entirely, so those are not accepted here at all - the folder rows and the
 * folder sort are mandatory instead.
 */
export interface BuildThreadListSectionsFolderInput {
  /** Resolved from `roots` by the caller; this package stays DB-free. */
  readonly folderRowsByRootId: ReadonlyMap<string, ThreadFolderRow>;
  readonly folderSortBy: ThreadsPanelFolderSortBy;
  readonly groupBy: 'folder';
  readonly threads: readonly AssistantMemoryThread[];
}

/** Group/flat grouping's inputs. Folder rows are meaningless in these modes. */
export interface BuildThreadListSectionsGroupInput {
  readonly groupBy: Exclude<ThreadsPanelGroupBy, 'folder'>;
  readonly groups: readonly AssistantThreadGroup[];
  readonly placements: readonly AssistantThreadPlacement[];
  readonly sortBy: ThreadsPanelSortBy;
  readonly threads: readonly AssistantMemoryThread[];
}

/**
 * Discriminated on `groupBy` so the compiler - not a runtime throw - enforces
 * that folder grouping arrives with its folder rows and folder sort, and that
 * the other modes arrive with their groups, placements, and `sortBy`.
 */
export type BuildThreadListSectionsInput =
  | BuildThreadListSectionsFolderInput
  | BuildThreadListSectionsGroupInput;

/**
 * Pure grouping/sorting core for the Threads panel. Placements referencing
 * unknown threads are ignored; placements referencing deleted groups fall back
 * to Ungrouped. Groups are ordered by their fractional rank; the Ungrouped
 * section always renders last (after every group). Folder grouping is a
 * separate mode with its own view kind and its own input arm.
 */
export function buildThreadListSections(input: BuildThreadListSectionsInput): ThreadListView {
  if (input.groupBy === 'folder') {
    return { kind: 'folders', sections: buildFolderSections(input) };
  }

  const { groupBy, groups, placements, sortBy, threads } = input;
  const threadIds = new Set(threads.map((thread) => thread.id));
  const livePlacements = placements.filter((placement) => threadIds.has(placement.threadId));
  const rankByThreadId = new Map<string, string>();
  for (const placement of livePlacements) {
    const rank = groupBy === 'none' ? placement.flatRank : placement.rank;
    if (rank !== null) {
      rankByThreadId.set(placement.threadId, rank);
    }
  }

  if (groupBy === 'none' || groups.length === 0) {
    return { kind: 'flat', threads: sortSection(threads, sortBy, rankByThreadId) };
  }

  const membership = buildThreadMembership({ groups, placements, threads });
  const threadsByGroupId = new Map<string, AssistantMemoryThread[]>(
    groups.map((group) => [group.id, []])
  );
  const ungroupedThreads: AssistantMemoryThread[] = [];

  // Bucket once instead of rescanning every thread for every rendered group.
  for (const thread of threads) {
    const groupId = membership.get(thread.id);
    if (groupId === undefined) {
      throw new Error(`Missing thread membership for ${thread.id}`);
    }
    if (groupId === null) {
      ungroupedThreads.push(thread);
      continue;
    }
    const groupThreads = threadsByGroupId.get(groupId);
    if (groupThreads === undefined) {
      throw new Error(`Missing thread group bucket for ${groupId}`);
    }
    groupThreads.push(thread);
  }

  const orderedGroups = [...groups].sort((left, right) =>
    left.rank < right.rank ? -1 : left.rank > right.rank ? 1 : left.id.localeCompare(right.id)
  );
  const sections = orderedGroups.map((group) => {
    const groupThreads = threadsByGroupId.get(group.id);
    if (groupThreads === undefined) {
      throw new Error(`Missing thread group bucket for ${group.id}`);
    }
    return {
      header: { group, kind: 'group' as const },
      id: group.id,
      threads: sortSection(groupThreads, sortBy, rankByThreadId),
    };
  });
  const ungrouped = sortSection(ungroupedThreads, sortBy, rankByThreadId);
  return { kind: 'grouped', sections, ungrouped };
}

function resolveSectionThreads(
  view: Exclude<ThreadListView, { readonly kind: 'flat' }>,
  cache: GroupMemberIdsCache,
  sectionId: string | null
): readonly AssistantMemoryThread[] | undefined {
  if (sectionId !== null) {
    return cache.threadsBySectionId.get(sectionId);
  }
  return view.kind === 'grouped' ? view.ungrouped : undefined;
}

/**
 * Thread ids belonging to ONE section, addressed by `section.id` (a group id in
 * custom-groups mode, `folder:${rootId}` / `folder-unassigned` in folder mode).
 * `null` addresses the custom-groups Ungrouped section, which has no section id
 * of its own; folder mode has no such section and answers empty.
 */
export function getGroupMemberIds(
  view: ThreadListView,
  sectionId: string | null
): readonly string[] {
  if (view.kind === 'flat') {
    return EMPTY_THREAD_IDS;
  }
  let cache = groupMemberIdsByView.get(view);
  if (cache === undefined) {
    cache = {
      memberIdsBySectionId: new Map(),
      threadsBySectionId: new Map(
        view.sections.map((section) => [section.id, section.threads] as const)
      ),
    };
    groupMemberIdsByView.set(view, cache);
  }
  const cachedMemberIds = cache.memberIdsBySectionId.get(sectionId);
  if (cachedMemberIds !== undefined) {
    return cachedMemberIds;
  }
  const threads = resolveSectionThreads(view, cache, sectionId);
  if (threads === undefined) {
    return EMPTY_THREAD_IDS;
  }
  const memberIds = projectThreadIds(threads);
  cache.memberIdsBySectionId.set(sectionId, memberIds);
  return memberIds;
}
