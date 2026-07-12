import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
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

interface AssistantThreadGroupsState {
  applyThreadOrder: (
    repository: AssistantThreadGroupsRepository,
    resourceId: string,
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
  groupBy: ThreadsPanelGroupBy;
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
  setSortBy: (sortBy: ThreadsPanelSortBy) => void;
  sortBy: ThreadsPanelSortBy;
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
  groupBy: 'custom-groups' as ThreadsPanelGroupBy,
  sortBy: 'recency' as ThreadsPanelSortBy,
};

export const useAssistantThreadGroupsStore = create<AssistantThreadGroupsState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_VIEW_STATE,
      applyThreadOrder: async (
        repository: AssistantThreadGroupsRepository,
        resourceId: string,
        orderedEntries: readonly ThreadOrderEntry[]
      ): Promise<void> => {
        // A positional drop rewrites the affected section's ranks wholesale:
        // every listed thread gets a fresh fractional key in visual order, so
        // manual order is always fully materialized after the first drag.
        const ranks = generateNKeysBetween(null, null, orderedEntries.length);
        const placements = orderedEntries.map((entry, index) => ({
          groupId: entry.groupId,
          rank: ranks[index] as string,
          resourceId,
          threadId: entry.threadId,
        }));
        for (const placement of placements) {
          await repository.setThreadPlacement(placement);
        }
        set((state) => ({
          placementsByThreadId: {
            ...state.placementsByThreadId,
            ...Object.fromEntries(placements.map((placement) => [placement.threadId, placement])),
          },
          sortBy: 'custom',
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
        const reorderedGroups: AssistantThreadGroup[] = [];
        for (const [index, groupId] of orderedGroupIds.entries()) {
          const group = groupsById.get(groupId);
          if (!group) {
            throw new Error(`Unknown thread group: ${groupId}.`);
          }
          const rank = ranks[index] as string;
          await repository.setGroupRank(groupId, rank);
          reorderedGroups.push({ ...group, rank });
        }
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
      setSortBy: (sortBy: ThreadsPanelSortBy) => {
        set({ sortBy });
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
      name: 'brainstrike-assistant-thread-groups-v1',
      partialize: (state) => ({
        collapsedGroupIds: state.collapsedGroupIds,
        groupBy: state.groupBy,
        sortBy: state.sortBy,
      }),
      version: 1,
    }
  )
);
