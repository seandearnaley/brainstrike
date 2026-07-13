import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AssistantThreadGroup,
  AssistantThreadGroupsRepository,
  AssistantThreadPlacement,
} from '../assistant-thread-groups-repository';
import {
  migrateAssistantThreadGroupsPersistedState,
  useAssistantThreadGroupsStore,
} from '../assistant-thread-groups-store';

const RESOURCE_ID = 'workspace-a';

function makeGroup(overrides: { id: string; name?: string; rank: string }): AssistantThreadGroup {
  return {
    color: null,
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    rank: overrides.rank,
    resourceId: RESOURCE_ID,
  };
}

function makeRepository(overrides?: {
  groups?: readonly AssistantThreadGroup[];
  placements?: readonly AssistantThreadPlacement[];
}): AssistantThreadGroupsRepository {
  let groupCounter = 0;
  return {
    clearThreadPlacement: vi.fn(async () => undefined),
    createGroup: vi.fn(async (resourceId: string, name: string, rank: string) => {
      groupCounter += 1;
      return {
        color: null,
        id: `thread-group-created-${groupCounter}`,
        name: name.trim(),
        rank,
        resourceId,
      };
    }),
    deleteGroup: vi.fn(async () => undefined),
    listGroups: vi.fn(async () => overrides?.groups ?? []),
    listPlacements: vi.fn(async () => overrides?.placements ?? []),
    renameGroup: vi.fn(async () => undefined),
    setGroupColor: vi.fn(async () => undefined),
    setGroupRank: vi.fn(async () => undefined),
    setGroupRanks: vi.fn(async () => undefined),
    setThreadPlacement: vi.fn(async () => undefined),
    setThreadPlacements: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  useAssistantThreadGroupsStore.getState().reset();
});

describe('useAssistantThreadGroupsStore', () => {
  it('loads groups and placements on ensureGroups', async () => {
    const repository = makeRepository({
      groups: [makeGroup({ id: 'group-1', rank: 'a0' })],
      placements: [
        {
          flatRank: 'b0',
          groupId: 'group-1',
          rank: 'a0',
          resourceId: RESOURCE_ID,
          threadId: 'thread-1',
        },
      ],
    });

    await useAssistantThreadGroupsStore.getState().ensureGroups(repository, RESOURCE_ID);

    const state = useAssistantThreadGroupsStore.getState();
    expect(state.loadStateByResourceId[RESOURCE_ID]).toEqual({ status: 'ready' });
    expect(state.groupsByResourceId[RESOURCE_ID]?.map((group) => group.id)).toEqual(['group-1']);
    expect(state.placementsByThreadId['thread-1']?.groupId).toBe('group-1');
  });

  it('records an explicit error state when loading fails', async () => {
    const repository = makeRepository();
    vi.mocked(repository.listGroups).mockRejectedValue(new Error('load failed'));

    await expect(
      useAssistantThreadGroupsStore.getState().ensureGroups(repository, RESOURCE_ID)
    ).rejects.toThrow('load failed');

    expect(useAssistantThreadGroupsStore.getState().loadStateByResourceId[RESOURCE_ID]).toEqual({
      error: 'load failed',
      status: 'error',
    });
  });

  it('creates a group ranked after the last group', async () => {
    const repository = makeRepository({
      groups: [makeGroup({ id: 'group-1', rank: 'a0' })],
    });
    const store = useAssistantThreadGroupsStore.getState();
    await store.ensureGroups(repository, RESOURCE_ID);

    const created = await store.createGroup(repository, RESOURCE_ID, 'Research');

    const [, , rank] = vi.mocked(repository.createGroup).mock.calls[0] ?? [];
    expect(typeof rank).toBe('string');
    expect(String(rank) > 'a0').toBe(true);
    const groups = useAssistantThreadGroupsStore.getState().groupsByResourceId[RESOURCE_ID] ?? [];
    expect(groups.map((group) => group.id)).toEqual(['group-1', created.id]);
  });

  it('renames a group locally and in the repository', async () => {
    const repository = makeRepository({ groups: [makeGroup({ id: 'group-1', rank: 'a0' })] });
    const store = useAssistantThreadGroupsStore.getState();
    await store.ensureGroups(repository, RESOURCE_ID);

    await store.renameGroup(repository, RESOURCE_ID, 'group-1', 'Deep Work');

    expect(repository.renameGroup).toHaveBeenCalledWith('group-1', 'Deep Work');
    expect(
      useAssistantThreadGroupsStore.getState().groupsByResourceId[RESOURCE_ID]?.[0]?.name
    ).toBe('Deep Work');
  });

  it('sets and clears a group color locally and in the repository', async () => {
    const repository = makeRepository({ groups: [makeGroup({ id: 'group-1', rank: 'a0' })] });
    const store = useAssistantThreadGroupsStore.getState();
    await store.ensureGroups(repository, RESOURCE_ID);

    await store.setGroupColor(repository, RESOURCE_ID, 'group-1', 'amber');
    expect(repository.setGroupColor).toHaveBeenCalledWith('group-1', 'amber');
    expect(
      useAssistantThreadGroupsStore.getState().groupsByResourceId[RESOURCE_ID]?.[0]?.color
    ).toBe('amber');

    await store.setGroupColor(repository, RESOURCE_ID, 'group-1', null);
    expect(
      useAssistantThreadGroupsStore.getState().groupsByResourceId[RESOURCE_ID]?.[0]?.color
    ).toBeNull();
  });

  it('deletes a group and returns its threads to ungrouped locally', async () => {
    const repository = makeRepository({
      groups: [makeGroup({ id: 'group-1', rank: 'a0' })],
      placements: [
        {
          flatRank: null,
          groupId: 'group-1',
          rank: 'a0',
          resourceId: RESOURCE_ID,
          threadId: 'thread-1',
        },
        {
          flatRank: null,
          groupId: null,
          rank: 'a1',
          resourceId: RESOURCE_ID,
          threadId: 'thread-2',
        },
      ],
    });
    const store = useAssistantThreadGroupsStore.getState();
    await store.ensureGroups(repository, RESOURCE_ID);

    await store.deleteGroup(repository, RESOURCE_ID, 'group-1');

    expect(repository.deleteGroup).toHaveBeenCalledWith('group-1');
    const state = useAssistantThreadGroupsStore.getState();
    expect(state.groupsByResourceId[RESOURCE_ID]).toEqual([]);
    expect(state.placementsByThreadId['thread-1']).toBeUndefined();
    expect(state.placementsByThreadId['thread-2']).toBeDefined();
  });

  it('reorders groups by assigning fresh ranks in the given order', async () => {
    const repository = makeRepository({
      groups: [makeGroup({ id: 'group-1', rank: 'a0' }), makeGroup({ id: 'group-2', rank: 'a1' })],
    });
    const store = useAssistantThreadGroupsStore.getState();
    await store.ensureGroups(repository, RESOURCE_ID);

    await store.reorderGroups(repository, RESOURCE_ID, ['group-2', 'group-1']);

    expect(repository.setGroupRanks).toHaveBeenCalledTimes(1);
    const [entries] = vi.mocked(repository.setGroupRanks).mock.calls[0] ?? [];
    expect(entries?.map((entry) => entry.groupId)).toEqual(['group-2', 'group-1']);
    expect(String(entries?.[0]?.rank) < String(entries?.[1]?.rank)).toBe(true);
    expect(
      useAssistantThreadGroupsStore
        .getState()
        .groupsByResourceId[RESOURCE_ID]?.map((group) => group.id)
    ).toEqual(['group-2', 'group-1']);
  });

  it('moves a thread to the end of a group', async () => {
    const repository = makeRepository({
      groups: [makeGroup({ id: 'group-1', rank: 'a0' })],
      placements: [
        {
          flatRank: null,
          groupId: 'group-1',
          rank: 'a0',
          resourceId: RESOURCE_ID,
          threadId: 'thread-1',
        },
      ],
    });
    const store = useAssistantThreadGroupsStore.getState();
    await store.ensureGroups(repository, RESOURCE_ID);

    await store.moveThreadToGroup(repository, RESOURCE_ID, 'thread-2', 'group-1');

    const [placement] = vi.mocked(repository.setThreadPlacement).mock.calls[0] ?? [];
    expect(placement?.threadId).toBe('thread-2');
    expect(placement?.groupId).toBe('group-1');
    expect(String(placement?.rank) > 'a0').toBe(true);
    expect(useAssistantThreadGroupsStore.getState().placementsByThreadId['thread-2']?.groupId).toBe(
      'group-1'
    );
  });

  it('does nothing when the thread is already in the target group', async () => {
    const repository = makeRepository({
      groups: [makeGroup({ id: 'group-1', rank: 'a0' })],
      placements: [
        {
          flatRank: null,
          groupId: 'group-1',
          rank: 'a0',
          resourceId: RESOURCE_ID,
          threadId: 'thread-1',
        },
      ],
    });
    const store = useAssistantThreadGroupsStore.getState();
    await store.ensureGroups(repository, RESOURCE_ID);

    await store.moveThreadToGroup(repository, RESOURCE_ID, 'thread-1', 'group-1');

    expect(repository.setThreadPlacement).not.toHaveBeenCalled();
  });

  it('applies grouped order without changing flat rank or flat sort', async () => {
    const repository = makeRepository();
    const store = useAssistantThreadGroupsStore.getState();
    await store.ensureGroups(repository, RESOURCE_ID);
    useAssistantThreadGroupsStore.setState({
      placementsByThreadId: {
        'thread-1': {
          flatRank: 'z1',
          groupId: 'group-1',
          rank: 'a0',
          resourceId: RESOURCE_ID,
          threadId: 'thread-1',
        },
      },
    });

    await store.applyThreadOrder(repository, RESOURCE_ID, 'grouped', [
      { groupId: 'group-1', threadId: 'thread-2' },
      { groupId: 'group-1', threadId: 'thread-1' },
    ]);

    expect(repository.setThreadPlacements).toHaveBeenCalledTimes(1);
    const [batch] = vi.mocked(repository.setThreadPlacements).mock.calls[0] ?? [];
    expect(batch?.map((placement) => placement.threadId)).toEqual(['thread-2', 'thread-1']);
    const firstRank = String(batch?.[0]?.rank);
    const secondRank = String(batch?.[1]?.rank);
    expect(firstRank < secondRank).toBe(true);
    expect(batch?.[1]?.flatRank).toBe('z1');
    expect(useAssistantThreadGroupsStore.getState().groupedSortBy).toBe('custom');
    expect(useAssistantThreadGroupsStore.getState().flatSortBy).toBe('recency');
    expect(useAssistantThreadGroupsStore.getState().placementsByThreadId['thread-2']?.rank).toBe(
      firstRank
    );
  });

  it('applies flat order without changing grouped rank or grouped sort', async () => {
    const repository = makeRepository({
      placements: [
        {
          flatRank: null,
          groupId: 'group-1',
          rank: 'group-rank',
          resourceId: RESOURCE_ID,
          threadId: 'thread-1',
        },
      ],
    });
    const store = useAssistantThreadGroupsStore.getState();
    await store.ensureGroups(repository, RESOURCE_ID);

    await store.applyThreadOrder(repository, RESOURCE_ID, 'flat', [
      { groupId: 'group-1', threadId: 'thread-1' },
      { groupId: null, threadId: 'thread-2' },
    ]);

    const [batch] = vi.mocked(repository.setThreadPlacements).mock.calls[0] ?? [];
    expect(batch?.[0]?.rank).toBe('group-rank');
    expect(batch?.[0]?.flatRank).toBeTruthy();
    expect(useAssistantThreadGroupsStore.getState().flatSortBy).toBe('custom');
    expect(useAssistantThreadGroupsStore.getState().groupedSortBy).toBe('recency');
  });

  it('clears a deleted thread placement', async () => {
    const repository = makeRepository({
      placements: [
        {
          flatRank: null,
          groupId: null,
          rank: 'a0',
          resourceId: RESOURCE_ID,
          threadId: 'thread-1',
        },
      ],
    });
    const store = useAssistantThreadGroupsStore.getState();
    await store.ensureGroups(repository, RESOURCE_ID);

    await store.removeThreadPlacement(repository, 'thread-1');

    expect(repository.clearThreadPlacement).toHaveBeenCalledWith('thread-1');
    expect(
      useAssistantThreadGroupsStore.getState().placementsByThreadId['thread-1']
    ).toBeUndefined();
  });

  it('toggles group collapse and updates independent view preferences', () => {
    const store = useAssistantThreadGroupsStore.getState();

    store.toggleGroupCollapsed('group-1');
    expect(useAssistantThreadGroupsStore.getState().collapsedGroupIds['group-1']).toBe(true);
    useAssistantThreadGroupsStore.getState().toggleGroupCollapsed('group-1');
    expect(useAssistantThreadGroupsStore.getState().collapsedGroupIds['group-1']).toBeUndefined();

    store.setGroupBy('none');
    store.setSortBy('flat', 'name');
    store.setSortBy('grouped', 'custom');
    expect(useAssistantThreadGroupsStore.getState().groupBy).toBe('none');
    expect(useAssistantThreadGroupsStore.getState().flatSortBy).toBe('name');
    expect(useAssistantThreadGroupsStore.getState().groupedSortBy).toBe('custom');
  });

  it('migrates the version-1 sort into both presentation scopes', () => {
    expect(
      migrateAssistantThreadGroupsPersistedState(
        { collapsedGroupIds: { 'group-1': true }, groupBy: 'none', sortBy: 'name' },
        1
      )
    ).toEqual({
      collapsedGroupIds: { 'group-1': true },
      flatSortBy: 'name',
      groupBy: 'none',
      groupedSortBy: 'name',
    });
  });

  it('rejects malformed legacy sort state instead of guessing', () => {
    expect(() =>
      migrateAssistantThreadGroupsPersistedState({ groupBy: 'none', sortBy: 'oldest' }, 1)
    ).toThrow('Invalid persisted thread sort: oldest.');
  });

  it('reset restores defaults', async () => {
    const repository = makeRepository({ groups: [makeGroup({ id: 'group-1', rank: 'a0' })] });
    const store = useAssistantThreadGroupsStore.getState();
    await store.ensureGroups(repository, RESOURCE_ID);
    store.setSortBy('flat', 'name');
    store.setSortBy('grouped', 'custom');
    store.toggleGroupCollapsed('group-1');

    useAssistantThreadGroupsStore.getState().reset();

    const state = useAssistantThreadGroupsStore.getState();
    expect(state.groupsByResourceId).toEqual({});
    expect(state.placementsByThreadId).toEqual({});
    expect(state.flatSortBy).toBe('recency');
    expect(state.groupedSortBy).toBe('recency');
    expect(state.groupBy).toBe('custom-groups');
    expect(state.collapsedGroupIds).toEqual({});
  });
});
