import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AssistantThreadColorId, AssistantThreadIconId } from './assistant-memory-repository';
import type {
  AssistantThreadGroup,
  AssistantThreadGroupsRepository,
  AssistantThreadPlacement,
} from './assistant-thread-groups-repository';
import {
  FOLDER_SECTION_ID_PREFIX,
  folderSectionId,
  type ThreadsPanelFolderSortBy,
  type ThreadsPanelGroupBy,
  type ThreadsPanelSortBy,
} from './thread-list-sections';

type ThreadGroupsLoadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly error: string; readonly status: 'error' };

export interface ThreadOrderEntry {
  readonly groupId: string | null;
  readonly threadId: string;
}

/**
 * The two presentations that own a MANUAL order. Folder mode deliberately is
 * not one of them: folder sections are name/recency only, so a drag there has
 * nowhere to persist and `setFolderSortBy` is its dedicated view-pref action.
 */
export type ThreadOrderPresentation = 'flat' | 'grouped';

/** Session-only Threads-panel filters; never persisted, cleared by `reset()`. */
export interface ThreadFilters {
  readonly hasPr: boolean;
  readonly needsYou: boolean;
  readonly running: boolean;
  readonly unseen: boolean;
}

interface PersistedAssistantThreadGroupsState {
  readonly collapsedGroupIds: Record<string, true>;
  readonly flatSortBy: ThreadsPanelSortBy;
  readonly folderSortBy: ThreadsPanelFolderSortBy;
  readonly groupBy: ThreadsPanelGroupBy;
  readonly groupedSortBy: ThreadsPanelSortBy;
}

interface AssistantThreadGroupsState {
  applyThreadOrder: (
    repository: AssistantThreadGroupsRepository,
    resourceId: string,
    presentation: ThreadOrderPresentation,
    orderedEntries: readonly ThreadOrderEntry[]
  ) => Promise<void>;
  clearThreadFilters: () => void;
  collapsedGroupIds: Record<string, true>;
  createGroup: (
    repository: AssistantThreadGroupsRepository,
    resourceId: string,
    name: string
  ) => Promise<AssistantThreadGroup>;
  deleteGroup: (
    repository: AssistantThreadGroupsRepository,
    resourceId: string,
    groupId: string
  ) => Promise<void>;
  ensureGroups: (repository: AssistantThreadGroupsRepository, resourceId: string) => Promise<void>;
  flatSortBy: ThreadsPanelSortBy;
  folderSortBy: ThreadsPanelFolderSortBy;
  groupBy: ThreadsPanelGroupBy;
  groupedSortBy: ThreadsPanelSortBy;
  groupsByResourceId: Record<string, AssistantThreadGroup[]>;
  loadStateByResourceId: Record<string, ThreadGroupsLoadState>;
  moveThreadsToGroup: (
    repository: AssistantThreadGroupsRepository,
    resourceId: string,
    threadIds: readonly string[],
    groupId: string | null
  ) => Promise<void>;
  moveThreadToGroup: (
    repository: AssistantThreadGroupsRepository,
    resourceId: string,
    threadId: string,
    groupId: string | null
  ) => Promise<void>;
  placementsByThreadId: Record<string, AssistantThreadPlacement>;
  pruneDeletedThreadPlacements: (threadIds: readonly string[]) => void;
  /**
   * Drops `folder:${rootId}` collapse keys for roots not in `liveRootIds` —
   * the symmetric half of the group-key prune in `deleteGroup`.
   *
   * Folder sections are a VIEW over threads (there are no empty ones), so the
   * live set is the roots that currently have a section. Group keys and the
   * `folder-unassigned` sentinel are never touched: the sentinel is not keyed
   * by a root, and group keys belong to `deleteGroup`.
   *
   * CALL IT ONLY WITH A SET YOU ACTUALLY KNOW. "No sections resolved" is not
   * evidence that no root has one — it is also what loading, a failed folder
   * query, and every non-folder grouping mode look like — and pruning on that
   * would silently wipe every folder's collapse state.
   */
  pruneFolderCollapseIds: (liveRootIds: readonly string[]) => void;
  removeThreadPlacement: (
    repository: AssistantThreadGroupsRepository,
    threadId: string
  ) => Promise<void>;
  removeThreadPlacements: (
    repository: AssistantThreadGroupsRepository,
    threadIds: readonly string[]
  ) => Promise<void>;
  renameGroup: (
    repository: AssistantThreadGroupsRepository,
    resourceId: string,
    groupId: string,
    name: string
  ) => Promise<void>;
  reorderGroups: (
    repository: AssistantThreadGroupsRepository,
    resourceId: string,
    orderedGroupIds: readonly string[]
  ) => Promise<void>;
  reset: () => void;
  setFolderSortBy: (folderSortBy: ThreadsPanelFolderSortBy) => void;
  setGroupBy: (groupBy: ThreadsPanelGroupBy) => void;
  setGroupColor: (
    repository: AssistantThreadGroupsRepository,
    resourceId: string,
    groupId: string,
    color: AssistantThreadColorId | null
  ) => Promise<void>;
  setGroupIcon: (
    repository: AssistantThreadGroupsRepository,
    resourceId: string,
    groupId: string,
    icon: AssistantThreadIconId | null
  ) => Promise<void>;
  setSortBy: (presentation: ThreadOrderPresentation, sortBy: ThreadsPanelSortBy) => void;
  setThreadFilter: (filter: keyof ThreadFilters, enabled: boolean) => void;
  threadFilters: ThreadFilters;
  toggleGroupCollapsed: (groupId: string) => void;
}

const resourceGroupsLoadPromises = new Map<string, Promise<void>>();
let resourceGroupsLoadGeneration = 0;

function sortGroups(groups: readonly AssistantThreadGroup[]): AssistantThreadGroup[] {
  return [...groups].sort((left, right) =>
    left.rank < right.rank ? -1 : left.rank > right.rank ? 1 : left.id.localeCompare(right.id)
  );
}

function omitRecordKey<T>(record: Record<string, T>, keyToOmit: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== keyToOmit));
}

function requireThreadIds(threadIds: readonly string[]): readonly string[] {
  if (!Array.isArray(threadIds)) {
    throw new Error('Thread ids must be an array.');
  }
  const seenIds = new Set<string>();
  for (const threadId of threadIds) {
    if (typeof threadId !== 'string' || !threadId.trim()) {
      throw new Error('Thread id is required.');
    }
    if (seenIds.has(threadId)) {
      throw new Error(`Duplicate thread id: ${threadId}.`);
    }
    seenIds.add(threadId);
  }
  return threadIds;
}

const DEFAULT_THREAD_FILTERS: ThreadFilters = {
  hasPr: false,
  needsYou: false,
  running: false,
  unseen: false,
};

const DEFAULT_VIEW_STATE = {
  collapsedGroupIds: {} as Record<string, true>,
  flatSortBy: 'recency' as ThreadsPanelSortBy,
  folderSortBy: 'recency' as ThreadsPanelFolderSortBy,
  groupBy: 'custom-groups' as ThreadsPanelGroupBy,
  groupedSortBy: 'recency' as ThreadsPanelSortBy,
  threadFilters: DEFAULT_THREAD_FILTERS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requirePersistedSort(value: unknown): ThreadsPanelSortBy {
  if (value === 'custom' || value === 'name' || value === 'recency') {
    return value;
  }
  throw new Error(`Invalid persisted thread sort: ${String(value)}.`);
}

function requirePersistedGroupBy(value: unknown): ThreadsPanelGroupBy {
  if (value === 'custom-groups' || value === 'folder' || value === 'none') {
    return value;
  }
  throw new Error(`Invalid persisted thread grouping: ${String(value)}.`);
}

function requirePersistedFolderSort(value: unknown): ThreadsPanelFolderSortBy {
  if (value === 'name' || value === 'recency') {
    return value;
  }
  throw new Error(`Invalid persisted thread folder sort: ${String(value)}.`);
}

function requireCollapsedGroupIds(value: unknown): Record<string, true> {
  if (!isRecord(value)) {
    throw new Error('Invalid persisted collapsed thread groups.');
  }
  for (const collapsed of Object.values(value)) {
    if (collapsed !== true) {
      throw new Error('Invalid persisted collapsed thread groups.');
    }
  }
  return value as Record<string, true>;
}

export function migrateAssistantThreadGroupsPersistedState(
  persistedState: unknown,
  version: number
): PersistedAssistantThreadGroupsState {
  if (!isRecord(persistedState)) {
    throw new Error('Invalid persisted assistant thread groups state.');
  }
  const collapsedGroupIds = requireCollapsedGroupIds(persistedState['collapsedGroupIds'] ?? {});
  const groupBy = requirePersistedGroupBy(persistedState['groupBy']);
  if (version < 2) {
    const legacySortBy = requirePersistedSort(persistedState['sortBy']);
    return {
      collapsedGroupIds,
      flatSortBy: legacySortBy,
      folderSortBy: DEFAULT_VIEW_STATE.folderSortBy,
      groupBy,
      groupedSortBy: legacySortBy,
    };
  }
  return {
    collapsedGroupIds,
    flatSortBy: requirePersistedSort(persistedState['flatSortBy']),
    // Folder grouping arrived in version 3; older blobs adopt the default.
    folderSortBy:
      version < 3
        ? DEFAULT_VIEW_STATE.folderSortBy
        : requirePersistedFolderSort(persistedState['folderSortBy']),
    groupBy,
    groupedSortBy: requirePersistedSort(persistedState['groupedSortBy']),
  };
}

export const useAssistantThreadGroupsStore = create<AssistantThreadGroupsState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_VIEW_STATE,
      applyThreadOrder: async (
        repository: AssistantThreadGroupsRepository,
        resourceId: string,
        presentation: ThreadOrderPresentation,
        orderedEntries: readonly ThreadOrderEntry[]
      ): Promise<void> => {
        // A positional drop rewrites the affected section's ranks wholesale:
        // every listed thread gets a fresh fractional key in visual order, so
        // manual order is always fully materialized after the first drag. The
        // repository writes the batch as ONE multi-row upsert, so a failure
        // can never persist a half-reordered section.
        const ranks = generateNKeysBetween(null, null, orderedEntries.length);
        const placements = orderedEntries.map((entry, index) => {
          const currentPlacement = get().placementsByThreadId[entry.threadId];
          const freshRank = ranks[index] as string;
          return {
            flatRank: presentation === 'flat' ? freshRank : (currentPlacement?.flatRank ?? null),
            groupId: entry.groupId,
            rank: presentation === 'grouped' ? freshRank : (currentPlacement?.rank ?? freshRank),
            resourceId,
            threadId: entry.threadId,
          };
        });
        await repository.setThreadPlacements(placements);
        set((state) => ({
          ...(presentation === 'flat'
            ? { flatSortBy: 'custom' as const }
            : { groupedSortBy: 'custom' as const }),
          placementsByThreadId: {
            ...state.placementsByThreadId,
            ...Object.fromEntries(placements.map((placement) => [placement.threadId, placement])),
          },
        }));
      },
      clearThreadFilters: () => {
        set({ threadFilters: DEFAULT_THREAD_FILTERS });
      },
      createGroup: async (
        repository: AssistantThreadGroupsRepository,
        resourceId: string,
        name: string
      ): Promise<AssistantThreadGroup> => {
        const currentGroups = get().groupsByResourceId[resourceId] ?? [];
        const lastRank = currentGroups.at(-1)?.rank ?? null;
        const group = await repository.createGroup(
          resourceId,
          name,
          generateKeyBetween(lastRank, null)
        );
        set((state) => ({
          groupsByResourceId: {
            ...state.groupsByResourceId,
            [resourceId]: sortGroups([...(state.groupsByResourceId[resourceId] ?? []), group]),
          },
        }));
        return group;
      },
      deleteGroup: async (
        repository: AssistantThreadGroupsRepository,
        resourceId: string,
        groupId: string
      ): Promise<void> => {
        await repository.deleteGroup(groupId);
        set((state) => ({
          collapsedGroupIds: Object.fromEntries(
            Object.entries(state.collapsedGroupIds).filter(([key]) => key !== groupId)
          ) as Record<string, true>,
          groupsByResourceId: {
            ...state.groupsByResourceId,
            [resourceId]: (state.groupsByResourceId[resourceId] ?? []).filter(
              (group) => group.id !== groupId
            ),
          },
          placementsByThreadId: Object.fromEntries(
            Object.entries(state.placementsByThreadId).map(([threadId, placement]) => [
              threadId,
              placement.groupId === groupId ? { ...placement, groupId: null } : placement,
            ])
          ),
        }));
      },
      ensureGroups: async (
        repository: AssistantThreadGroupsRepository,
        resourceId: string
      ): Promise<void> => {
        const existingLoad = resourceGroupsLoadPromises.get(resourceId);
        if (existingLoad) {
          return existingLoad;
        }
        const currentLoadStatus = get().loadStateByResourceId[resourceId]?.status;
        if (currentLoadStatus === 'ready' || currentLoadStatus === 'loading') {
          return;
        }

        const loadGeneration = resourceGroupsLoadGeneration;
        const loadPromise = (async () => {
          set((state) => ({
            loadStateByResourceId: {
              ...state.loadStateByResourceId,
              [resourceId]: { status: 'loading' },
            },
          }));
          try {
            const [groups, placements] = await Promise.all([
              repository.listGroups(resourceId),
              repository.listPlacements(resourceId),
            ]);
            if (loadGeneration !== resourceGroupsLoadGeneration) {
              return;
            }
            set((state) => ({
              groupsByResourceId: {
                ...state.groupsByResourceId,
                [resourceId]: sortGroups(groups),
              },
              loadStateByResourceId: {
                ...state.loadStateByResourceId,
                [resourceId]: { status: 'ready' },
              },
              placementsByThreadId: {
                ...state.placementsByThreadId,
                ...Object.fromEntries(
                  placements.map((placement) => [placement.threadId, placement])
                ),
              },
            }));
          } catch (error) {
            if (loadGeneration !== resourceGroupsLoadGeneration) {
              throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            set((state) => ({
              loadStateByResourceId: {
                ...state.loadStateByResourceId,
                [resourceId]: { error: message, status: 'error' },
              },
            }));
            throw error;
          } finally {
            if (loadGeneration === resourceGroupsLoadGeneration) {
              resourceGroupsLoadPromises.delete(resourceId);
            }
          }
        })();

        resourceGroupsLoadPromises.set(resourceId, loadPromise);
        return loadPromise;
      },
      groupsByResourceId: {},
      loadStateByResourceId: {},
      moveThreadsToGroup: async (
        repository: AssistantThreadGroupsRepository,
        resourceId: string,
        threadIds: readonly string[],
        groupId: string | null
      ): Promise<void> => {
        requireThreadIds(threadIds);
        if (threadIds.length === 0) {
          return;
        }
        const state = get();
        if (
          groupId !== null &&
          !(state.groupsByResourceId[resourceId] ?? []).some((group) => group.id === groupId)
        ) {
          throw new Error(`Unknown thread group: ${groupId}.`);
        }
        const actionableThreadIds = threadIds.filter((threadId) => {
          const currentPlacement = state.placementsByThreadId[threadId];
          if (!currentPlacement) {
            return groupId !== null;
          }
          return currentPlacement.groupId !== groupId;
        });
        if (actionableThreadIds.length === 0) {
          return;
        }
        const sectionRanks = Object.values(state.placementsByThreadId)
          .filter(
            (placement) => placement.resourceId === resourceId && placement.groupId === groupId
          )
          .map((placement) => placement.rank)
          .sort();
        const ranks = generateNKeysBetween(
          sectionRanks.at(-1) ?? null,
          null,
          actionableThreadIds.length
        );
        const placements = actionableThreadIds.map((threadId, index) => {
          const currentPlacement = state.placementsByThreadId[threadId];
          return {
            flatRank: currentPlacement?.flatRank ?? null,
            groupId,
            rank: ranks[index] as string,
            resourceId,
            threadId,
          } satisfies AssistantThreadPlacement;
        });
        await repository.setThreadPlacements(placements);
        set((current) => ({
          placementsByThreadId: {
            ...current.placementsByThreadId,
            ...Object.fromEntries(placements.map((placement) => [placement.threadId, placement])),
          },
        }));
      },
      moveThreadToGroup: async (
        repository: AssistantThreadGroupsRepository,
        resourceId: string,
        threadId: string,
        groupId: string | null
      ): Promise<void> => {
        const state = get();
        const currentPlacement = state.placementsByThreadId[threadId];
        if ((currentPlacement?.groupId ?? null) === groupId && currentPlacement) {
          return;
        }
        if (!currentPlacement && groupId === null) {
          return;
        }
        // Append to the end of the destination section's manual order.
        const sectionRanks = Object.values(state.placementsByThreadId)
          .filter(
            (placement) => placement.resourceId === resourceId && placement.groupId === groupId
          )
          .map((placement) => placement.rank)
          .sort();
        const placement: AssistantThreadPlacement = {
          flatRank: currentPlacement?.flatRank ?? null,
          groupId,
          rank: generateKeyBetween(sectionRanks.at(-1) ?? null, null),
          resourceId,
          threadId,
        };
        await repository.setThreadPlacement(placement);
        set((current) => ({
          placementsByThreadId: {
            ...current.placementsByThreadId,
            [threadId]: placement,
          },
        }));
      },
      placementsByThreadId: {},
      pruneDeletedThreadPlacements: (threadIds: readonly string[]): void => {
        requireThreadIds(threadIds);
        if (threadIds.length === 0) {
          return;
        }
        const deletedThreadIds = new Set(threadIds);
        set((state) => ({
          placementsByThreadId: Object.fromEntries(
            Object.entries(state.placementsByThreadId).filter(
              ([threadId]) => !deletedThreadIds.has(threadId)
            )
          ),
        }));
      },
      pruneFolderCollapseIds: (liveRootIds: readonly string[]): void => {
        const liveSectionIds = new Set(liveRootIds.map((rootId) => folderSectionId(rootId)));
        set((state) => {
          const kept = Object.entries(state.collapsedGroupIds).filter(
            ([key]) => !key.startsWith(FOLDER_SECTION_ID_PREFIX) || liveSectionIds.has(key)
          );
          if (kept.length === Object.keys(state.collapsedGroupIds).length) {
            // Same state object: zustand skips the notification entirely, so
            // the panel effect that calls this on every folder-row resolution
            // cannot loop through its own subscribers.
            return state;
          }
          return { collapsedGroupIds: Object.fromEntries(kept) as Record<string, true> };
        });
      },
      removeThreadPlacement: async (
        repository: AssistantThreadGroupsRepository,
        threadId: string
      ): Promise<void> => {
        await repository.clearThreadPlacement(threadId);
        set((state) => ({
          placementsByThreadId: omitRecordKey(state.placementsByThreadId, threadId),
        }));
      },
      removeThreadPlacements: async (
        repository: AssistantThreadGroupsRepository,
        threadIds: readonly string[]
      ): Promise<void> => {
        requireThreadIds(threadIds);
        if (threadIds.length === 0) {
          return;
        }
        await repository.clearThreadPlacements(threadIds);
        const removedThreadIds = new Set(threadIds);
        set((state) => ({
          placementsByThreadId: Object.fromEntries(
            Object.entries(state.placementsByThreadId).filter(
              ([threadId]) => !removedThreadIds.has(threadId)
            )
          ),
        }));
      },
      renameGroup: async (
        repository: AssistantThreadGroupsRepository,
        resourceId: string,
        groupId: string,
        name: string
      ): Promise<void> => {
        const normalizedName = name.trim();
        await repository.renameGroup(groupId, normalizedName);
        set((state) => ({
          groupsByResourceId: {
            ...state.groupsByResourceId,
            [resourceId]: (state.groupsByResourceId[resourceId] ?? []).map((group) =>
              group.id === groupId ? { ...group, name: normalizedName } : group
            ),
          },
        }));
      },
      reorderGroups: async (
        repository: AssistantThreadGroupsRepository,
        resourceId: string,
        orderedGroupIds: readonly string[]
      ): Promise<void> => {
        const currentGroups = get().groupsByResourceId[resourceId] ?? [];
        const groupsById = new Map(currentGroups.map((group) => [group.id, group]));
        const ranks = generateNKeysBetween(null, null, orderedGroupIds.length);
        const reorderedGroups: AssistantThreadGroup[] = orderedGroupIds.map((groupId, index) => {
          const group = groupsById.get(groupId);
          if (!group) {
            throw new Error(`Unknown thread group: ${groupId}.`);
          }
          return { ...group, rank: ranks[index] as string };
        });
        // Single-statement batch: the whole reorder lands atomically.
        await repository.setGroupRanks(
          reorderedGroups.map((group) => ({ groupId: group.id, rank: group.rank }))
        );
        set((state) => ({
          groupsByResourceId: {
            ...state.groupsByResourceId,
            [resourceId]: reorderedGroups,
          },
        }));
      },
      reset: () => {
        resourceGroupsLoadGeneration += 1;
        resourceGroupsLoadPromises.clear();
        set({
          ...DEFAULT_VIEW_STATE,
          groupsByResourceId: {},
          loadStateByResourceId: {},
          placementsByThreadId: {},
        });
      },
      setFolderSortBy: (folderSortBy: ThreadsPanelFolderSortBy) => {
        set({ folderSortBy });
      },
      setGroupBy: (groupBy: ThreadsPanelGroupBy) => {
        set({ groupBy });
      },
      setGroupColor: async (
        repository: AssistantThreadGroupsRepository,
        resourceId: string,
        groupId: string,
        color: AssistantThreadColorId | null
      ): Promise<void> => {
        await repository.setGroupColor(groupId, color);
        set((state) => ({
          groupsByResourceId: {
            ...state.groupsByResourceId,
            [resourceId]: (state.groupsByResourceId[resourceId] ?? []).map((group) =>
              group.id === groupId ? { ...group, color } : group
            ),
          },
        }));
      },
      setGroupIcon: async (
        repository: AssistantThreadGroupsRepository,
        resourceId: string,
        groupId: string,
        icon: AssistantThreadIconId | null
      ): Promise<void> => {
        await repository.setGroupIcon(groupId, icon);
        set((state) => ({
          groupsByResourceId: {
            ...state.groupsByResourceId,
            [resourceId]: (state.groupsByResourceId[resourceId] ?? []).map((group) =>
              group.id === groupId ? { ...group, icon } : group
            ),
          },
        }));
      },
      setSortBy: (presentation: ThreadOrderPresentation, sortBy: ThreadsPanelSortBy) => {
        set(presentation === 'flat' ? { flatSortBy: sortBy } : { groupedSortBy: sortBy });
      },
      setThreadFilter: (filter: keyof ThreadFilters, enabled: boolean) => {
        set((state) => ({ threadFilters: { ...state.threadFilters, [filter]: enabled } }));
      },
      toggleGroupCollapsed: (groupId: string) => {
        set((state) => {
          if (state.collapsedGroupIds[groupId]) {
            return {
              collapsedGroupIds: Object.fromEntries(
                Object.entries(state.collapsedGroupIds).filter(([key]) => key !== groupId)
              ) as Record<string, true>,
            };
          }
          return { collapsedGroupIds: { ...state.collapsedGroupIds, [groupId]: true } };
        });
      },
    }),
    {
      migrate: migrateAssistantThreadGroupsPersistedState,
      name: 'brainstrike-assistant-thread-groups-v1',
      partialize: (state): PersistedAssistantThreadGroupsState => ({
        collapsedGroupIds: state.collapsedGroupIds,
        flatSortBy: state.flatSortBy,
        folderSortBy: state.folderSortBy,
        groupBy: state.groupBy,
        groupedSortBy: state.groupedSortBy,
      }),
      version: 3,
    }
  )
);
