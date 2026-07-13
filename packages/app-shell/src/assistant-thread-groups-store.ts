import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AssistantThreadColorId } from './assistant-memory-repository';
import type {
  AssistantThreadGroup,
  AssistantThreadGroupsRepository,
  AssistantThreadPlacement,
} from './assistant-thread-groups-repository';
import type { ThreadsPanelGroupBy, ThreadsPanelSortBy } from './thread-list-sections';

type ThreadGroupsLoadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly error: string; readonly status: 'error' };

export interface ThreadOrderEntry {
  readonly groupId: string | null;
  readonly threadId: string;
}

export type ThreadOrderPresentation = 'flat' | 'grouped';

interface PersistedAssistantThreadGroupsState {
  readonly collapsedGroupIds: Record<string, true>;
  readonly flatSortBy: ThreadsPanelSortBy;
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
  groupBy: ThreadsPanelGroupBy;
  groupedSortBy: ThreadsPanelSortBy;
  groupsByResourceId: Record<string, AssistantThreadGroup[]>;
  loadStateByResourceId: Record<string, ThreadGroupsLoadState>;
  moveThreadToGroup: (
    repository: AssistantThreadGroupsRepository,
    resourceId: string,
    threadId: string,
    groupId: string | null
  ) => Promise<void>;
  placementsByThreadId: Record<string, AssistantThreadPlacement>;
  removeThreadPlacement: (
    repository: AssistantThreadGroupsRepository,
    threadId: string
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
  setGroupBy: (groupBy: ThreadsPanelGroupBy) => void;
  setGroupColor: (
    repository: AssistantThreadGroupsRepository,
    resourceId: string,
    groupId: string,
    color: AssistantThreadColorId | null
  ) => Promise<void>;
  setSortBy: (presentation: ThreadOrderPresentation, sortBy: ThreadsPanelSortBy) => void;
  toggleGroupCollapsed: (groupId: string) => void;
}

const resourceGroupsLoadPromises = new Map<string, Promise<void>>();

function sortGroups(groups: readonly AssistantThreadGroup[]): AssistantThreadGroup[] {
  return [...groups].sort((left, right) =>
    left.rank < right.rank ? -1 : left.rank > right.rank ? 1 : left.id.localeCompare(right.id)
  );
}

function omitRecordKey<T>(record: Record<string, T>, keyToOmit: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== keyToOmit));
}

const DEFAULT_VIEW_STATE = {
  collapsedGroupIds: {} as Record<string, true>,
  flatSortBy: 'recency' as ThreadsPanelSortBy,
  groupBy: 'custom-groups' as ThreadsPanelGroupBy,
  groupedSortBy: 'recency' as ThreadsPanelSortBy,
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
  if (value === 'custom-groups' || value === 'none') {
    return value;
  }
  throw new Error(`Invalid persisted thread grouping: ${String(value)}.`);
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
      groupBy,
      groupedSortBy: legacySortBy,
    };
  }
  return {
    collapsedGroupIds,
    flatSortBy: requirePersistedSort(persistedState['flatSortBy']),
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
            Object.entries(state.placementsByThreadId).filter(
              ([, placement]) => placement.groupId !== groupId
            )
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
            const message = error instanceof Error ? error.message : String(error);
            set((state) => ({
              loadStateByResourceId: {
                ...state.loadStateByResourceId,
                [resourceId]: { error: message, status: 'error' },
              },
            }));
            throw error;
          } finally {
            resourceGroupsLoadPromises.delete(resourceId);
          }
        })();

        resourceGroupsLoadPromises.set(resourceId, loadPromise);
        return loadPromise;
      },
      groupsByResourceId: {},
      loadStateByResourceId: {},
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
      removeThreadPlacement: async (
        repository: AssistantThreadGroupsRepository,
        threadId: string
      ): Promise<void> => {
        await repository.clearThreadPlacement(threadId);
        set((state) => ({
          placementsByThreadId: omitRecordKey(state.placementsByThreadId, threadId),
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
        resourceGroupsLoadPromises.clear();
        set({
          ...DEFAULT_VIEW_STATE,
          groupsByResourceId: {},
          loadStateByResourceId: {},
          placementsByThreadId: {},
        });
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
      setSortBy: (presentation: ThreadOrderPresentation, sortBy: ThreadsPanelSortBy) => {
        set(presentation === 'flat' ? { flatSortBy: sortBy } : { groupedSortBy: sortBy });
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
        groupBy: state.groupBy,
        groupedSortBy: state.groupedSortBy,
      }),
      version: 2,
    }
  )
);
