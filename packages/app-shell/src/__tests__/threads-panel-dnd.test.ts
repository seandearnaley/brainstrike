// @vitest-environment node
import type {
  AssistantMemoryThread,
  AssistantThreadGroup,
  ThreadListView,
} from '@brainstrike/assistant-data';
import { describe, expect, it } from 'vitest';
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
    {
      header: { group: GROUP_A, kind: 'group' },
      id: GROUP_A.id,
      threads: [makeThread('thread-1'), makeThread('thread-2')],
    },
    {
      header: { group: GROUP_B, kind: 'group' },
      id: GROUP_B.id,
      threads: [makeThread('thread-3')],
    },
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
      filtersActive: false,
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
      filtersActive: false,
      groupIdByThreadId: MEMBERSHIP,
      source: { groupId: 'group-a', threadId: 'thread-1', type: 'thread-row' },
      target: { groupId: 'group-a', type: 'group-header' },
      view: GROUPED_VIEW,
    });

    expect(intent).toEqual({ kind: 'none' });
  });

  it('moves a grouped thread dropped on the ungrouped section out of its group', () => {
    const intent = resolveThreadsPanelDrop({
      filtersActive: false,
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
      filtersActive: false,
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
      filtersActive: false,
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
      filtersActive: false,
      groupIdByThreadId: MEMBERSHIP,
      source: { groupId: 'group-a', threadId: 'thread-1', type: 'thread-row' },
      target: { edge: 'top', groupId: 'group-a', threadId: 'thread-2', type: 'thread-row' },
      view: GROUPED_VIEW,
    });

    expect(intent).toEqual({ kind: 'none' });
  });

  it('returns none when a thread is dropped on itself', () => {
    const intent = resolveThreadsPanelDrop({
      filtersActive: false,
      groupIdByThreadId: MEMBERSHIP,
      source: { groupId: 'group-a', threadId: 'thread-1', type: 'thread-row' },
      target: { edge: 'top', groupId: 'group-a', threadId: 'thread-1', type: 'thread-row' },
      view: GROUPED_VIEW,
    });

    expect(intent).toEqual({ kind: 'none' });
  });

  it('reorders groups when a group header is dropped on another header edge', () => {
    const intent = resolveThreadsPanelDrop({
      filtersActive: false,
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
      filtersActive: false,
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
      filtersActive: false,
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

  it('resolves every drop to none in folder grouping instead of throwing at the user', () => {
    const foldersView: ThreadListView = {
      kind: 'folders',
      sections: [
        {
          header: {
            folder: { displayName: 'work', path: '/tmp/work', rootId: 'root-1' },
            kind: 'folder',
          },
          id: 'folder:root-1',
          threads: [makeThread('thread-1'), makeThread('thread-2')],
        },
      ],
    };
    // Folder sections carry no manual order and no membership, so the panel
    // renders no drag sources there. A drop that reaches this reducer anyway
    // (the monitor is global) must resolve to no intent, never throw.
    for (const target of [
      { edge: 'top', groupId: null, threadId: 'thread-2', type: 'thread-row' },
      { groupId: 'group-a', type: 'group-header' },
      { type: 'ungrouped-section' },
    ] as const) {
      expect(
        resolveThreadsPanelDrop({
          filtersActive: false,
          groupIdByThreadId: MEMBERSHIP,
          source: { groupId: null, threadId: 'thread-1', type: 'thread-row' },
          target,
          view: foldersView,
        })
      ).toEqual({ kind: 'none' });
    }
  });

  // A "Show only" filter renders a PARTIAL section, and `applyThreadOrder`
  // rewrites the whole listed section's ranks with one fresh key sequence — so
  // a drop resolved against the filtered view renumbers only the visible
  // threads and leaves the hidden ones on their old ranks. Clearing the filter
  // then reveals the two sequences interleaved, an order the user never chose.
  // The panel renders no row drag sources while a filter is active; the drop
  // monitor is global, so a drop that arrives anyway resolves to no intent.
  it('resolves every row drop to none while a Show only filter narrows the list', () => {
    for (const target of [
      { edge: 'top', groupId: 'group-a', threadId: 'thread-1', type: 'thread-row' },
      { groupId: 'group-b', type: 'group-header' },
      { type: 'ungrouped-section' },
    ] as const) {
      expect(
        resolveThreadsPanelDrop({
          filtersActive: true,
          groupIdByThreadId: MEMBERSHIP,
          source: { groupId: 'group-a', threadId: 'thread-2', type: 'thread-row' },
          target,
          view: GROUPED_VIEW,
        })
      ).toEqual({ kind: 'none' });
    }
  });

  // A section is minted per GROUP, not per surviving thread, so no filter can
  // drop one: a group reorder stays a complete rewrite, and stays live.
  it('still reorders groups while a Show only filter narrows the list', () => {
    const intent = resolveThreadsPanelDrop({
      filtersActive: true,
      groupIdByThreadId: MEMBERSHIP,
      source: { groupId: 'group-b', type: 'group-header' },
      target: { edge: 'top', groupId: 'group-a', type: 'group-header' },
      view: GROUPED_VIEW,
    });

    expect(intent).toEqual({ kind: 'reorder-groups', orderedGroupIds: ['group-b', 'group-a'] });
  });

  it('returns none when a group header is dropped on a thread row', () => {
    const intent = resolveThreadsPanelDrop({
      filtersActive: false,
      groupIdByThreadId: MEMBERSHIP,
      source: { groupId: 'group-a', type: 'group-header' },
      target: { edge: 'top', groupId: null, threadId: 'thread-4', type: 'thread-row' },
      view: GROUPED_VIEW,
    });

    expect(intent).toEqual({ kind: 'none' });
  });
});
