import type { AssistantMemoryThread } from './assistant-memory-repository.ts';
import type {
  AssistantThreadGroup,
  AssistantThreadPlacement,
} from './assistant-thread-groups-repository.ts';

export type ThreadsPanelGroupBy = 'custom-groups' | 'date' | 'folder' | 'none';
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

/**
 * Display facts for ONE repository (ADR-0034 decision 1), resolved by the
 * caller from the host's worktree listing. Its own checkout and its managed
 * worktrees are its checkouts, so their threads share its section.
 */
export interface ThreadRepositoryRow {
  /** The branch its own checkout is on; null on a detached HEAD. */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly displayName: string;
  /** Its own checkout as an open folder, where a new thread starts; null while that folder is not open. */
  readonly folder: ThreadFolderRow | null;
  /**
   * What its section is keyed on. Opaque here: the caller derives it in one
   * place, today from the repository's realpath'd git common dir, so a project
   * id can replace it there (ADR-0034, owner decisions 2026-11-10).
   */
  readonly key: string;
  /** Its own checkout's path. */
  readonly path: string;
}

/** The run times a thread's activity is read from: its latest run, if it has one. */
export interface ThreadActivityRun {
  readonly completedAt: Date | null;
  readonly startedAt: Date | null;
}

/**
 * When the thread last had conversation activity: its latest run's start or
 * finish, or its creation. NOT `updatedAt`, which is the catalog's last append
 * of any kind, so a rename, a colour or a folder move would reorder the list
 * while a conversation that just ran stayed put.
 */
export function getThreadLastActivityAt(
  thread: Pick<AssistantMemoryThread, 'createdAt'>,
  latestRun: ThreadActivityRun | undefined
): number {
  return Math.max(
    thread.createdAt.getTime(),
    latestRun?.startedAt?.getTime() ?? 0,
    latestRun?.completedAt?.getTime() ?? 0
  );
}

/**
 * What every grouping needs to order threads: their activity times and their
 * pins. Pinned threads leave their section for the Pinned section, newest pin
 * first; the flat list has no sections, so it lists them first instead.
 */
export interface ThreadListOrdering {
  readonly lastActivityAt: (thread: AssistantMemoryThread) => number;
  /** Epoch ms of each pin; a thread absent here is not pinned. */
  readonly pinnedAtByThreadId: Readonly<Record<string, number>>;
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
/** A repository section (folder mode): its own checkout's threads and its worktrees'. */
export interface ThreadListRepositoryHeader {
  readonly kind: 'repository';
  readonly repository: ThreadRepositoryRow;
}
/** The trailing "No folder" section (folder mode only). */
export interface ThreadListUnassignedHeader {
  readonly kind: 'unassigned';
}
/** A recency section (date mode): Today, Yesterday, Previous 7 days, a month. */
export interface ThreadListDateHeader {
  readonly kind: 'date';
  readonly label: string;
}
/** Pinned threads, above every other section. */
export interface ThreadListPinnedHeader {
  readonly kind: 'pinned';
}
export type ThreadListSectionHeader =
  | ThreadListDateHeader
  | ThreadListFolderHeader
  | ThreadListGroupHeader
  | ThreadListPinnedHeader
  | ThreadListRepositoryHeader
  | ThreadListUnassignedHeader;

interface ThreadListSectionBase {
  readonly id: string;
  readonly threads: readonly AssistantMemoryThread[];
}
/** `id` is the group id, so grouped section ids stay drag/drop identities. */
export interface ThreadListGroupSection extends ThreadListSectionBase {
  readonly header: ThreadListGroupHeader;
}
/** `id` is `repository:${key}`, `folder:${rootId}` or `folder-unassigned`. */
export interface ThreadListFolderSection extends ThreadListSectionBase {
  readonly header: ThreadListFolderHeader | ThreadListRepositoryHeader | ThreadListUnassignedHeader;
}
/** `id` is `date:${bucket}`: `date:today`, `date:2026-08` and so on. */
export interface ThreadListDateSection extends ThreadListSectionBase {
  readonly header: ThreadListDateHeader;
}
/** `id` is {@link PINNED_SECTION_ID}. */
export interface ThreadListPinnedSection extends ThreadListSectionBase {
  readonly header: ThreadListPinnedHeader;
}
export type ThreadListSection =
  | ThreadListDateSection
  | ThreadListFolderSection
  | ThreadListGroupSection
  | ThreadListPinnedSection;

/** Every sectioned view carries its Pinned section, `null` while nothing is pinned. */
interface PinnedView {
  readonly pinned: ThreadListPinnedSection | null;
}
export type ThreadListView =
  | { readonly kind: 'flat'; readonly threads: readonly AssistantMemoryThread[] }
  | (PinnedView & {
      readonly kind: 'grouped';
      readonly sections: readonly ThreadListGroupSection[];
      readonly ungrouped: readonly AssistantMemoryThread[];
    })
  | (PinnedView & {
      readonly kind: 'folders';
      readonly sections: readonly ThreadListFolderSection[];
    })
  | (PinnedView & {
      readonly kind: 'dates';
      readonly sections: readonly ThreadListDateSection[];
    });

/** Section id of the Pinned section, in every mode that has sections. */
export const PINNED_SECTION_ID = 'pinned';
/** The prefix every date section id carries. */
export const DATE_SECTION_ID_PREFIX = 'date:';

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

/**
 * The prefix every repository section id carries. A repository is identified
 * by its own key (see `ThreadRepositoryRow.key`), never by a root id, so its sections have their own
 * id space: a folder that stops being a repository's checkout gets a fresh
 * `folder:` section rather than inheriting the repository's collapse state.
 *
 * Collapse keys under it are kept, not pruned: a repository is listed only
 * while one of its folders is open, so pruning on the listing would forget a
 * collapsed repository each time its folder closed.
 */
const REPOSITORY_SECTION_ID_PREFIX = 'repository:';

/** Section id for the repository keyed `key`. */
export function repositorySectionId(key: string): string {
  return `${REPOSITORY_SECTION_ID_PREFIX}${key}`;
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

type ThreadComparator = (left: AssistantMemoryThread, right: AssistantMemoryThread) => number;

function byRecency(ordering: ThreadListOrdering): ThreadComparator {
  return (left, right) => {
    const byActivity = ordering.lastActivityAt(right) - ordering.lastActivityAt(left);
    return byActivity === 0 ? left.id.localeCompare(right.id) : byActivity;
  };
}

function compareByName(left: AssistantMemoryThread, right: AssistantMemoryThread): number {
  const byTitle = left.title.localeCompare(right.title, undefined, { sensitivity: 'base' });
  return byTitle === 0 ? left.id.localeCompare(right.id) : byTitle;
}

function sortSection(
  threads: readonly AssistantMemoryThread[],
  sortBy: ThreadsPanelSortBy,
  rankByThreadId: ReadonlyMap<string, string>,
  ordering: ThreadListOrdering
): AssistantMemoryThread[] {
  const compareByRecency = byRecency(ordering);
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

type FolderSectionHeader = ThreadListFolderHeader | ThreadListRepositoryHeader;

/** The name a section sorts and reads by, with its id as the tie-break. */
function folderSectionName(header: FolderSectionHeader): string {
  return header.kind === 'repository' ? header.repository.displayName : header.folder.displayName;
}

/** One section's threads plus the header that opened the bucket. */
interface FolderBucket {
  readonly header: FolderSectionHeader;
  readonly id: string;
  readonly threads: AssistantMemoryThread[];
}

/**
 * Where one thread sits in folder grouping: its repository when its folder is
 * one of that repository's checkouts, its folder otherwise, and `null` ("No
 * folder") when it has no folder or the folder has no display row.
 */
function resolveFolderSection(
  thread: AssistantMemoryThread,
  { folderRowsByRootId, repositoryByThreadId }: BuildThreadListSectionsFolderInput
): { readonly header: FolderSectionHeader; readonly id: string } | null {
  const repository = repositoryByThreadId.get(thread.id);
  if (repository !== undefined) {
    return {
      header: { kind: 'repository', repository },
      id: repositorySectionId(repository.key),
    };
  }
  const rootId = getThreadPrimaryRootId(thread);
  const folder = rootId === null ? undefined : folderRowsByRootId.get(rootId);
  return folder === undefined
    ? null
    : { header: { folder, kind: 'folder' }, id: folderSectionId(folder.rootId) };
}

/**
 * Folder sections for the Threads panel: one section per repository (its own
 * checkout and its managed worktrees together), one per other workspace folder,
 * alphabetical by display name, with a trailing "No folder" section for threads
 * whose primary root is missing, blank, or has no display row. An unresolved
 * root id is NOT an error here - the builder stays pure and the calling hook
 * logs it.
 */
function buildFolderSections(
  input: BuildThreadListSectionsFolderInput,
  threads: readonly AssistantMemoryThread[]
): ThreadListFolderSection[] {
  // The bucket carries the header that opened it, so the section pass never has
  // to resolve it a second time.
  const bucketsById = new Map<string, FolderBucket>();
  const unassignedThreads: AssistantMemoryThread[] = [];
  for (const thread of threads) {
    const section = resolveFolderSection(thread, input);
    if (section === null) {
      unassignedThreads.push(thread);
      continue;
    }
    const bucket = bucketsById.get(section.id);
    if (bucket === undefined) {
      bucketsById.set(section.id, { ...section, threads: [thread] });
      continue;
    }
    bucket.threads.push(thread);
  }

  const compareThreads = input.folderSortBy === 'name' ? compareByName : byRecency(input.ordering);
  const sections: ThreadListFolderSection[] = [...bucketsById.values()]
    .sort((left, right) => {
      const byName = folderSectionName(left.header).localeCompare(
        folderSectionName(right.header),
        undefined,
        { sensitivity: 'base' }
      );
      return byName === 0 ? left.id.localeCompare(right.id) : byName;
    })
    .map((bucket) => ({
      header: bucket.header,
      id: bucket.id,
      threads: bucket.threads.sort(compareThreads),
    }));
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
 * entirely, so those are not accepted here at all - the folder rows, the
 * repositories and the folder sort are mandatory instead.
 */
export interface BuildThreadListSectionsFolderInput {
  /** Resolved from `roots` by the caller; this package stays DB-free. */
  readonly folderRowsByRootId: ReadonlyMap<string, ThreadFolderRow>;
  readonly folderSortBy: ThreadsPanelFolderSortBy;
  readonly groupBy: 'folder';
  readonly ordering: ThreadListOrdering;
  /**
   * The repository each thread works in, for a thread whose folder is that
   * repository's own checkout or one of its managed worktrees. Resolved by the
   * caller from the host's worktree listing; this package never matches a
   * worktree to a repository. A thread absent here groups by its folder.
   */
  readonly repositoryByThreadId: ReadonlyMap<string, ThreadRepositoryRow>;
  readonly threads: readonly AssistantMemoryThread[];
}

/** Group/flat grouping's inputs. Folder rows are meaningless in these modes. */
export interface BuildThreadListSectionsGroupInput {
  readonly groupBy: 'custom-groups' | 'none';
  readonly groups: readonly AssistantThreadGroup[];
  readonly ordering: ThreadListOrdering;
  readonly placements: readonly AssistantThreadPlacement[];
  readonly sortBy: ThreadsPanelSortBy;
  readonly threads: readonly AssistantMemoryThread[];
}

/**
 * Date grouping's inputs: recency is the order, so there is no sort to choose.
 * `now` places the day boundaries, in the local time zone.
 */
export interface BuildThreadListSectionsDateInput {
  readonly groupBy: 'date';
  readonly now: Date;
  readonly ordering: ThreadListOrdering;
  readonly threads: readonly AssistantMemoryThread[];
}

/**
 * Discriminated on `groupBy` so the compiler - not a runtime throw - enforces
 * that each grouping arrives with exactly the inputs it reads.
 */
export type BuildThreadListSectionsInput =
  | BuildThreadListSectionsDateInput
  | BuildThreadListSectionsFolderInput
  | BuildThreadListSectionsGroupInput;

const DAY_LABELS = {
  'previous-7-days': 'Previous 7 days',
  'previous-30-days': 'Previous 30 days',
  today: 'Today',
  yesterday: 'Yesterday',
} as const;

/** Local midnight `days` days before `now`'s day, DST-safe. */
function startOfDay(now: Date, days: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime();
}

/**
 * The recency section of one activity time: Today, Yesterday, Previous 7 days,
 * Previous 30 days, then one section per calendar month. A time after `now`
 * (another machine's clock) is Today rather than an invented future section.
 */
export function getThreadDateSection(
  activityAt: number,
  now: Date
): { readonly id: string; readonly label: string } {
  const recent =
    activityAt >= startOfDay(now, 0)
      ? 'today'
      : activityAt >= startOfDay(now, 1)
        ? 'yesterday'
        : activityAt >= startOfDay(now, 7)
          ? 'previous-7-days'
          : activityAt >= startOfDay(now, 30)
            ? 'previous-30-days'
            : null;
  if (recent !== null) {
    return { id: `${DATE_SECTION_ID_PREFIX}${recent}`, label: DAY_LABELS[recent] };
  }
  const date = new Date(activityAt);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const label = new Intl.DateTimeFormat(undefined, {
    month: 'long',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(date);
  return { id: `${DATE_SECTION_ID_PREFIX}${date.getFullYear()}-${month}`, label };
}

/** Threads sorted newest first are already in section order, so one pass buckets them. */
function buildDateSections(
  { now, ordering }: BuildThreadListSectionsDateInput,
  threads: readonly AssistantMemoryThread[]
): ThreadListDateSection[] {
  const sections: { header: ThreadListDateHeader; id: string; threads: AssistantMemoryThread[] }[] =
    [];
  for (const thread of [...threads].sort(byRecency(ordering))) {
    const { id, label } = getThreadDateSection(ordering.lastActivityAt(thread), now);
    const current = sections.at(-1);
    if (current?.id === id) {
      current.threads.push(thread);
      continue;
    }
    sections.push({ header: { kind: 'date', label }, id, threads: [thread] });
  }
  return sections;
}

/** Lifts pinned threads out of the list: the Pinned section, and the rest. */
function partitionPinned(
  threads: readonly AssistantMemoryThread[],
  { pinnedAtByThreadId }: ThreadListOrdering
): {
  readonly pinned: ThreadListPinnedSection | null;
  readonly rest: readonly AssistantMemoryThread[];
} {
  const pinnedThreads = threads.filter((thread) => pinnedAtByThreadId[thread.id] !== undefined);
  if (pinnedThreads.length === 0) {
    return { pinned: null, rest: threads };
  }
  const pinnedAt = (thread: AssistantMemoryThread): number => pinnedAtByThreadId[thread.id] ?? 0;
  pinnedThreads.sort(
    (left, right) => pinnedAt(right) - pinnedAt(left) || left.id.localeCompare(right.id)
  );
  return {
    pinned: { header: { kind: 'pinned' }, id: PINNED_SECTION_ID, threads: pinnedThreads },
    rest: threads.filter((thread) => pinnedAtByThreadId[thread.id] === undefined),
  };
}

/**
 * Pure grouping/sorting core for the Threads panel. Placements referencing
 * unknown threads are ignored; placements referencing deleted groups fall back
 * to Ungrouped. Groups are ordered by their fractional rank; the Ungrouped
 * section always renders last (after every group). Pinned threads lead every
 * view: as their own section where there are sections, first in the flat list.
 */
export function buildThreadListSections(input: BuildThreadListSectionsInput): ThreadListView {
  const { ordering } = input;
  const { pinned, rest } = partitionPinned(input.threads, ordering);
  if (input.groupBy === 'folder') {
    return { kind: 'folders', pinned, sections: buildFolderSections(input, rest) };
  }
  if (input.groupBy === 'date') {
    return { kind: 'dates', pinned, sections: buildDateSections(input, rest) };
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
    return {
      kind: 'flat',
      threads: [...(pinned?.threads ?? []), ...sortSection(rest, sortBy, rankByThreadId, ordering)],
    };
  }

  const membership = buildThreadMembership({ groups, placements, threads: rest });
  const threadsByGroupId = new Map<string, AssistantMemoryThread[]>(
    groups.map((group) => [group.id, []])
  );
  const ungroupedThreads: AssistantMemoryThread[] = [];

  // Bucket once instead of rescanning every thread for every rendered group.
  for (const thread of rest) {
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
      threads: sortSection(groupThreads, sortBy, rankByThreadId, ordering),
    };
  });
  const ungrouped = sortSection(ungroupedThreads, sortBy, rankByThreadId, ordering);
  return { kind: 'grouped', pinned, sections, ungrouped };
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
 * custom-groups mode, `repository:${key}` / `folder:${rootId}` /
 * `folder-unassigned` in folder mode,
 * `date:…` in date mode, {@link PINNED_SECTION_ID} for the Pinned section).
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
    const sections: readonly ThreadListSection[] = view.pinned
      ? [view.pinned, ...view.sections]
      : view.sections;
    cache = {
      memberIdsBySectionId: new Map(),
      threadsBySectionId: new Map(
        sections.map((section) => [section.id, section.threads] as const)
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
