import { afterEach, expect, test } from 'vitest';
import { StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(cleanupDirs);
const group = {
  color: 'rose' as const,
  icon: 'code' as const,
  id: 'thread-group-current',
  name: 'Current work',
  rank: 'a0',
  resourceId: 'brainstrike:workspace',
};
const placement = {
  flatRank: 'b0',
  groupId: group.id,
  rank: 'a0',
  resourceId: group.resourceId,
  threadId: 'current-thread',
};

test('existing group identity, presentation and placement ranks survive actual writer reopen', async () => {
  const root = freshDir('thread-groups');
  let store = await StateStore.open(root);
  try {
    await store.threadGroups({ group, operation: 'create' });
    await store.threadGroups({ operation: 'placements', placements: [placement] });
    await store.threadGroups({ groupId: group.id, name: 'Renamed work', operation: 'rename' });
    await store.threadGroups({ entries: [{ groupId: group.id, rank: 'a1' }], operation: 'ranks' });
    await store.threadGroups({ color: 'blue', groupId: group.id, operation: 'color' });
    await store.threadGroups({ groupId: group.id, icon: 'rocket', operation: 'icon' });
    await store.close();
    store = await StateStore.open(root);
    expect(await store.threadGroups({ operation: 'list', resourceId: group.resourceId })).toEqual({
      groups: [{ ...group, color: 'blue', icon: 'rocket', name: 'Renamed work', rank: 'a1' }],
      placements: [placement],
    });
    await store.threadGroups({ groupId: group.id, operation: 'delete' });
    expect(await store.threadGroups({ operation: 'list', resourceId: group.resourceId })).toEqual({
      groups: [],
      placements: [{ ...placement, groupId: null }],
    });
    await store.threadGroups({ operation: 'clear', threadIds: [placement.threadId] });
    expect(await store.threadGroups({ operation: 'list', resourceId: group.resourceId })).toEqual({
      groups: [],
      placements: [],
    });
  } finally {
    await store.close();
  }
});

test('group reorder and bulk placement failure preserve the complete prior snapshot', async () => {
  const store = await StateStore.open(freshDir('thread-group-atomic'));
  try {
    await store.threadGroups({ group, operation: 'create' });
    await store.threadGroups({ operation: 'placements', placements: [placement] });
    const before = await store.threadGroups({ operation: 'list', resourceId: group.resourceId });
    await expect(
      store.threadGroups({
        entries: [
          { groupId: group.id, rank: 'a2' },
          { groupId: 'missing', rank: 'a3' },
        ],
        operation: 'ranks',
      })
    ).rejects.toThrow();
    await expect(
      store.threadGroups({
        operation: 'placements',
        placements: [
          { ...placement, rank: 'a2' },
          { ...placement, groupId: 'missing', threadId: 'other' },
        ],
      })
    ).rejects.toThrow();
    expect(await store.threadGroups({ operation: 'list', resourceId: group.resourceId })).toEqual(
      before
    );
  } finally {
    await store.close();
  }
});
