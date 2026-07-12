import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AssistantThreadGroup,
  AssistantThreadGroupsRepository,
  AssistantThreadPlacement,
} from '../assistant-thread-groups-repository';
import { useAssistantThreadGroupsStore } from '../assistant-thread-groups-store';

const RESOURCE_ID = 'workspace-a';

function makeGroup(overrides: { id: string; name?: string; rank: string }): AssistantThreadGroup {
  return {
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
      return { id: `thread-group-created-${groupCounter}`, name: name.trim(), rank, resourceId };
    }),
    deleteGroup: vi.fn(async () => undefined),
    listGroups: vi.fn(async () => overrides?.groups ?? []),
    listPlacements: vi.fn(async () => overrides?.placements ?? []),
    renameGroup: vi.fn(async () => undefined),
    setGroupRank: vi.fn(async () => undefined),
    setThreadPlacement: vi.fn(async () => undefined),
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
        { groupId: 'group-1', rank: 'a0', resourceId: RESOURCE_ID, threadId: 'thread-1' },
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

  it('deletes a group and returns its threads to ungrouped locally', async () => {
    const repository = makeRepository({
      groups: [makeGroup({ id: 'group-1', rank: 'a0' })],
      placements: [
        { groupId: 'group-1', rank: 'a0', resourceId: RESOURCE_ID, threadId: 'thread-1' },
        { groupId: null, rank: 'a1', resourceId: RESOURCE_ID, threadId: 'thread-2' },
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

    const calls = vi.mocked(repository.setGroupRank).mock.calls;
    expect(calls.map(([groupId]) => groupId)).toEqual(['group-2', 'group-1']);
    const [, firstRank] = calls[0] ?? [];
    const [, secondRank] = calls[1] ?? [];
    expect(String(firstRank) < String(secondRank)).toBe(true);
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
        { groupId: 'group-1', rank: 'a0', resourceId: RESOURCE_ID, threadId: 'thread-1' },
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
        { groupId: 'group-1', rank: 'a0', resourceId: RESOURCE_ID, threadId: 'thread-1' },
      ],
    });
    const store = useAssistantThreadGroupsStore.getState();
    await store.ensureGroups(repository, RESOURCE_ID);

    await store.moveThreadToGroup(repository, RESOURCE_ID, 'thread-1', 'group-1');

    expect(repository.setThreadPlacement).not.toHaveBeenCalled();
  });

  it('applies an explicit thread order and switches sort to custom', async () => {
    const repository = makeRepository();
    const store = useAssistantThreadGroupsStore.getState();
    await store.ensureGroups(repository, RESOURCE_ID);
    expect(useAssistantThreadGroupsStore.getState().sortBy).toBe('recency');

    await store.applyThreadOrder(repository, RESOURCE_ID, [
      { groupId: 'group-1', threadId: 'thread-2' },
      { groupId: 'group-1', threadId: 'thread-1' },
    ]);

    const calls = vi.mocked(repository.setThreadPlacement).mock.calls;
    expect(calls.map(([placement]) => placement?.threadId)).toEqual(['thread-2', 'thread-1']);
    const firstRank = String(calls[0]?.[0]?.rank);
    const secondRank = String(calls[1]?.[0]?.rank);
    expect(firstRank < secondRank).toBe(true);
    expect(useAssistantThreadGroupsStore.getState().sortBy).toBe('custom');
    expect(useAssistantThreadGroupsStore.getState().placementsByThreadId['thread-2']?.rank).toBe(
      firstRank
    );
  });

  it('clears a deleted thread placement', async () => {
    const repository = makeRepository({
      placements: [{ groupId: null, rank: 'a0', resourceId: RESOURCE_ID, threadId: 'thread-1' }],
    });
    const store = useAssistantThreadGroupsStore.getState();
    await store.ensureGroups(repository, RESOURCE_ID);

    await store.removeThreadPlacement(repository, 'thread-1');

    expect(repository.clearThreadPlacement).toHaveBeenCalledWith('thread-1');
    expect(
      useAssistantThreadGroupsStore.getState().placementsByThreadId['thread-1']
    ).toBeUndefined();
  });

  it('toggles group collapse and updates view preferences', () => {
    const store = useAssistantThreadGroupsStore.getState();

    store.toggleGroupCollapsed('group-1');
    expect(useAssistantThreadGroupsStore.getState().collapsedGroupIds['group-1']).toBe(true);
    useAssistantThreadGroupsStore.getState().toggleGroupCollapsed('group-1');
    expect(useAssistantThreadGroupsStore.getState().collapsedGroupIds['group-1']).toBeUndefined();

    store.setGroupBy('none');
    store.setSortBy('name');
    expect(useAssistantThreadGroupsStore.getState().groupBy).toBe('none');
    expect(useAssistantThreadGroupsStore.getState().sortBy).toBe('name');
  });

  it('reset restores defaults', async () => {
    const repository = makeRepository({ groups: [makeGroup({ id: 'group-1', rank: 'a0' })] });
    const store = useAssistantThreadGroupsStore.getState();
    await store.ensureGroups(repository, RESOURCE_ID);
    store.setSortBy('name');
    store.toggleGroupCollapsed('group-1');

    useAssistantThreadGroupsStore.getState().reset();

    const state = useAssistantThreadGroupsStore.getState();
    expect(state.groupsByResourceId).toEqual({});
    expect(state.placementsByThreadId).toEqual({});
    expect(state.sortBy).toBe('recency');
    expect(state.groupBy).toBe('custom-groups');
    expect(state.collapsedGroupIds).toEqual({});
  });
});
