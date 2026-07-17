import { describe, expect, it } from 'vitest';
import type { AssistantMemoryThread } from '../assistant-memory-repository';
import type { AssistantThreadGroup } from '../assistant-thread-groups-repository';
import type { ThreadListView } from '../thread-list-sections';
import { resolveThreadsPanelDrop } from '../threads-panel-dnd';

function makeThread(id: string): AssistantMemoryThread {
  return {
    createdAt: new Date('2026-07-01T00:00:00Z'),
    id,
    resourceId: 'workspace-a',
    title: id,
    updatedAt: new Date('2026-07-01T00:00:00Z'),
  };
}

function makeGroup(id: string, rank: string): AssistantThreadGroup {
  return { color: null, icon: null, id, name: id, rank, resourceId: 'workspace-a' };
}

const GROUP_A = makeGroup('group-a', 'a0');
const GROUP_B = makeGroup('group-b', 'a1');

const GROUPED_VIEW: ThreadListView = {
  kind: 'grouped',
  sections: [
    { group: GROUP_A, threads: [makeThread('thread-1'), makeThread('thread-2')] },
    { group: GROUP_B, threads: [makeThread('thread-3')] },
  ],
  ungrouped: [makeThread('thread-4'), makeThread('thread-5')],
};

const MEMBERSHIP = new Map<string, string | null>([
  ['thread-1', 'group-a'],
  ['thread-2', 'group-a'],
  ['thread-3', 'group-b'],
  ['thread-4', null],
  ['thread-5', null],
]);

describe('resolveThreadsPanelDrop', () => {
  it('moves a thread dropped on another group header to that group', () => {
    const intent = resolveThreadsPanelDrop({
      groupIdByThreadId: MEMBERSHIP,
      source: { groupId: null, threadId: 'thread-4', type: 'thread-row' },
      target: { groupId: 'group-a', type: 'group-header' },
      view: GROUPED_VIEW,
    });

    expect(intent).toEqual({
      groupId: 'group-a',
      kind: 'move-thread-to-group',
      threadId: 'thread-4',
    });
  });

  it('ignores a thread dropped on its own group header', () => {
    const intent = resolveThreadsPanelDrop({
      groupIdByThreadId: MEMBERSHIP,
      source: { groupId: 'group-a', threadId: 'thread-1', type: 'thread-row' },
      target: { groupId: 'group-a', type: 'group-header' },
      view: GROUPED_VIEW,
    });

    expect(intent).toEqual({ kind: 'none' });
  });

  it('moves a grouped thread dropped on the ungrouped section out of its group', () => {
    const intent = resolveThreadsPanelDrop({
      groupIdByThreadId: MEMBERSHIP,
      source: { groupId: 'group-a', threadId: 'thread-1', type: 'thread-row' },
      target: { type: 'ungrouped-section' },
      view: GROUPED_VIEW,
    });

    expect(intent).toEqual({
      groupId: null,
      kind: 'move-thread-to-group',
      threadId: 'thread-1',
    });
  });

  it('reorders within a section when dropped on a sibling row edge', () => {
    const intent = resolveThreadsPanelDrop({
      groupIdByThreadId: MEMBERSHIP,
      source: { groupId: 'group-a', threadId: 'thread-2', type: 'thread-row' },
      target: { edge: 'top', groupId: 'group-a', threadId: 'thread-1', type: 'thread-row' },
      view: GROUPED_VIEW,
    });

    expect(intent).toEqual({
      kind: 'apply-thread-order',
      orderedEntries: [
        { groupId: 'group-a', threadId: 'thread-2' },
        { groupId: 'group-a', threadId: 'thread-1' },
      ],
    });
  });

  it('moves a thread into another section at the drop position', () => {
    const intent = resolveThreadsPanelDrop({
      groupIdByThreadId: MEMBERSHIP,
      source: { groupId: null, threadId: 'thread-5', type: 'thread-row' },
      target: { edge: 'bottom', groupId: 'group-a', threadId: 'thread-1', type: 'thread-row' },
      view: GROUPED_VIEW,
    });

    expect(intent).toEqual({
      kind: 'apply-thread-order',
      orderedEntries: [
        { groupId: 'group-a', threadId: 'thread-1' },
        { groupId: 'group-a', threadId: 'thread-5' },
        { groupId: 'group-a', threadId: 'thread-2' },
      ],
    });
  });

  it('returns none when the drop does not change the order', () => {
    const intent = resolveThreadsPanelDrop({
      groupIdByThreadId: MEMBERSHIP,
      source: { groupId: 'group-a', threadId: 'thread-1', type: 'thread-row' },
      target: { edge: 'top', groupId: 'group-a', threadId: 'thread-2', type: 'thread-row' },
      view: GROUPED_VIEW,
    });

    expect(intent).toEqual({ kind: 'none' });
  });

  it('returns none when a thread is dropped on itself', () => {
    const intent = resolveThreadsPanelDrop({
      groupIdByThreadId: MEMBERSHIP,
      source: { groupId: 'group-a', threadId: 'thread-1', type: 'thread-row' },
      target: { edge: 'top', groupId: 'group-a', threadId: 'thread-1', type: 'thread-row' },
      view: GROUPED_VIEW,
    });

    expect(intent).toEqual({ kind: 'none' });
  });

  it('reorders groups when a group header is dropped on another header edge', () => {
    const intent = resolveThreadsPanelDrop({
      groupIdByThreadId: MEMBERSHIP,
      source: { groupId: 'group-b', type: 'group-header' },
      target: { edge: 'top', groupId: 'group-a', type: 'group-header' },
      view: GROUPED_VIEW,
    });

    expect(intent).toEqual({
      kind: 'reorder-groups',
      orderedGroupIds: ['group-b', 'group-a'],
    });
  });

  it('returns none for a group reorder that keeps the current order', () => {
    const intent = resolveThreadsPanelDrop({
      groupIdByThreadId: MEMBERSHIP,
      source: { groupId: 'group-a', type: 'group-header' },
      target: { edge: 'top', groupId: 'group-b', type: 'group-header' },
      view: GROUPED_VIEW,
    });

    expect(intent).toEqual({ kind: 'none' });
  });

  it('reorders the flat list preserving each thread membership', () => {
    const flatView: ThreadListView = {
      kind: 'flat',
      threads: [makeThread('thread-1'), makeThread('thread-4'), makeThread('thread-3')],
    };

    const intent = resolveThreadsPanelDrop({
      groupIdByThreadId: MEMBERSHIP,
      source: { groupId: 'group-b', threadId: 'thread-3', type: 'thread-row' },
      target: { edge: 'top', groupId: 'group-a', threadId: 'thread-1', type: 'thread-row' },
      view: flatView,
    });

    expect(intent).toEqual({
      kind: 'apply-thread-order',
      orderedEntries: [
        { groupId: 'group-b', threadId: 'thread-3' },
        { groupId: 'group-a', threadId: 'thread-1' },
        { groupId: null, threadId: 'thread-4' },
      ],
    });
  });

  it('returns none when a group header is dropped on a thread row', () => {
    const intent = resolveThreadsPanelDrop({
      groupIdByThreadId: MEMBERSHIP,
      source: { groupId: 'group-a', type: 'group-header' },
      target: { edge: 'top', groupId: null, threadId: 'thread-4', type: 'thread-row' },
      view: GROUPED_VIEW,
    });

    expect(intent).toEqual({ kind: 'none' });
  });
});
