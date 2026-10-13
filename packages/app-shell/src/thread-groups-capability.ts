import type { AssistantThreadGroupsRepository } from '@brainstrike/assistant-data';
import type { ThreadGroupsCapability } from '@brainstrike/types';
export function getThreadGroupsCapability(): ThreadGroupsCapability | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window as Window & { threadGroups?: ThreadGroupsCapability }).threadGroups;
}
export function createNativeThreadGroupsRepository(
  capability: ThreadGroupsCapability
): AssistantThreadGroupsRepository {
  const request = capability.request.bind(capability);
  return {
    clearThreadPlacement: async (threadId) => {
      await request({ operation: 'clear', threadIds: [threadId] });
    },
    clearThreadPlacements: async (threadIds) => {
      await request({ operation: 'clear', threadIds });
    },
    createGroup: async (resourceId, name, rank) => {
      const result = await request({
        group: {
          color: null,
          icon: null,
          id: `thread-group-${crypto.randomUUID()}`,
          name,
          rank,
          resourceId,
        },
        operation: 'create',
      });
      const group = result.groups[0];
      if (!group) {
        throw new Error('Thread group creation returned no committed record');
      }
      return group;
    },
    deleteGroup: async (groupId) => {
      await request({ groupId, operation: 'delete' });
    },
    listGroups: async (resourceId) => (await request({ operation: 'list', resourceId })).groups,
    listPlacements: async (resourceId) =>
      (await request({ operation: 'list', resourceId })).placements,
    renameGroup: async (groupId, name) => {
      await request({ groupId, name, operation: 'rename' });
    },
    setGroupColor: async (groupId, color) => {
      await request({ color, groupId, operation: 'color' });
    },
    setGroupIcon: async (groupId, icon) => {
      await request({ groupId, icon, operation: 'icon' });
    },
    setGroupRank: async (groupId, rank) => {
      await request({ entries: [{ groupId, rank }], operation: 'ranks' });
    },
    setGroupRanks: async (entries) => {
      await request({ entries, operation: 'ranks' });
    },
    setThreadPlacement: async (placement) => {
      await request({ operation: 'placements', placements: [placement] });
    },
    setThreadPlacements: async (placements) => {
      await request({ operation: 'placements', placements });
    },
  };
}
