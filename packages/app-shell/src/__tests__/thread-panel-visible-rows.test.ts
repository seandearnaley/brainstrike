import type {
  AssistantMemoryThread,
  AssistantThreadGroup,
  ThreadFolderRow,
  ThreadListView,
} from '@brainstrike/assistant-data';
import { folderSectionId, UNASSIGNED_FOLDER_SECTION_ID } from '@brainstrike/assistant-data';
import { describe, expect, it } from 'vitest';
import { THREAD_CONTROL_ROW_PITCH_PX } from '../assistant-thread-presentation';
import {
  buildThreadPanelVisibleRows,
  filterThreadPanelSelection,
  getThreadPanelCollapseId,
  getThreadPanelMemberSectionId,
  getThreadPanelRowHeightPx,
  THREAD_PANEL_DISCLOSURE_INCREMENT,
  THREAD_PANEL_INITIAL_VISIBLE_LIMIT,
  type ThreadPanelGroupRow,
} from '../thread-panel-visible-rows';

function thread(id: string): AssistantMemoryThread {
  return {
    createdAt: new Date('2026-07-01T00:00:00Z'),
    id,
    resourceId: 'workspace-a',
    title: id,
    updatedAt: new Date('2026-07-01T00:00:00Z'),
  };
}

function group(id: string): AssistantThreadGroup {
  return { color: null, icon: null, id, name: id, rank: id, resourceId: 'workspace-a' };
}

describe('buildThreadPanelVisibleRows', () => {
  it('limits a flat list to 50 threads and reports the exact remainder', () => {
    const view: ThreadListView = {
      kind: 'flat',
      threads: Array.from({ length: 73 }, (_, index) => thread(`thread-${index}`)),
    };

    const result = buildThreadPanelVisibleRows({
      collapsedGroupIds: {},
      limitsBySectionKey: {},
      view,
    });

    expect(THREAD_PANEL_INITIAL_VISIBLE_LIMIT).toBe(50);
    expect(THREAD_PANEL_DISCLOSURE_INCREMENT).toBe(50);
    expect(result.visibleThreadIds).toHaveLength(50);
    expect(result.rows.at(-1)).toMatchObject({
      id: 'show-more:flat',
      kind: 'show-more',
      remainingCount: 23,
      sectionKey: 'flat',
    });
  });

  it('applies independent per-section limits and keeps total group counts', () => {
    const firstGroup = group('group-a');
    const secondGroup = group('group-b');
    const view: ThreadListView = {
      kind: 'grouped',
      sections: [
        {
          header: { group: firstGroup, kind: 'group' },
          id: firstGroup.id,
          threads: Array.from({ length: 55 }, (_, index) => thread(`a-${index}`)),
        },
        {
          header: { group: secondGroup, kind: 'group' },
          id: secondGroup.id,
          threads: Array.from({ length: 3 }, (_, index) => thread(`b-${index}`)),
        },
      ],
      ungrouped: Array.from({ length: 52 }, (_, index) => thread(`u-${index}`)),
    };

    const result = buildThreadPanelVisibleRows({
      collapsedGroupIds: {},
      limitsBySectionKey: { 'group:group-a': 100 },
      view,
    });

    expect(result.rows.find((row) => row.id === 'group:group-a')).toMatchObject({
      kind: 'group',
      totalCount: 55,
    });
    expect(result.rows.find((row) => row.id === 'group:group-b')).toMatchObject({
      kind: 'group',
      totalCount: 3,
    });
    expect(result.rows.find((row) => row.id === 'show-more:group:group-a')).toBeUndefined();
    expect(result.rows.find((row) => row.id === 'show-more:ungrouped')).toMatchObject({
      remainingCount: 2,
    });
    expect(result.visibleThreadIds).toHaveLength(55 + 3 + 50);
  });

  it('applies collapse before disclosure and emits no hidden children', () => {
    const collapsedGroup = group('group-collapsed');
    const view: ThreadListView = {
      kind: 'grouped',
      sections: [
        {
          header: { group: collapsedGroup, kind: 'group' },
          id: collapsedGroup.id,
          threads: Array.from({ length: 60 }, (_, index) => thread(`hidden-${index}`)),
        },
      ],
      ungrouped: [],
    };

    const result = buildThreadPanelVisibleRows({
      collapsedGroupIds: { 'group-collapsed': true },
      limitsBySectionKey: {},
      view,
    });

    expect(result.rows.find((row) => row.id === 'group:group-collapsed')).toMatchObject({
      collapsed: true,
      totalCount: 60,
    });
    expect(result.rows.some((row) => row.kind === 'thread')).toBe(false);
    expect(result.rows.some((row) => row.kind === 'show-more')).toBe(false);
    expect(result.visibleThreadIds).toEqual([]);
  });

  it('distinguishes truly empty sections from undisclosed sections', () => {
    const emptyGroup = group('group-empty');
    const view: ThreadListView = {
      kind: 'grouped',
      sections: [{ header: { group: emptyGroup, kind: 'group' }, id: emptyGroup.id, threads: [] }],
      ungrouped: [],
    };

    const result = buildThreadPanelVisibleRows({
      collapsedGroupIds: {},
      limitsBySectionKey: {},
      view,
    });

    expect(result.rows.map((row) => row.id)).toEqual([
      'group:group-empty',
      'empty:group:group-empty',
      'group:ungrouped',
      'empty:ungrouped',
    ]);
  });

  it('uses stable structural IDs and preserves thread IDs', () => {
    const view: ThreadListView = {
      kind: 'grouped',
      sections: [
        {
          header: { group: group('group-a'), kind: 'group' },
          id: 'group-a',
          threads: [thread('thread-a')],
        },
      ],
      ungrouped: [thread('thread-b')],
    };

    const result = buildThreadPanelVisibleRows({
      collapsedGroupIds: {},
      limitsBySectionKey: {},
      view,
    });

    expect(result.rows.map((row) => row.id)).toEqual([
      'group:group-a',
      'thread-a',
      'group:ungrouped',
      'thread-b',
    ]);
  });

  it('renders a folders view as section rows keyed by their own section ids', () => {
    const folder: ThreadFolderRow = {
      displayName: 'brainstrike',
      path: '/tmp/brainstrike',
      rootId: 'root-1',
    };
    const view: ThreadListView = {
      kind: 'folders',
      sections: [
        {
          header: { folder, kind: 'folder' },
          id: folderSectionId(folder.rootId),
          threads: [thread('thread-a')],
        },
        {
          header: { kind: 'unassigned' },
          id: UNASSIGNED_FOLDER_SECTION_ID,
          threads: [thread('thread-b')],
        },
      ],
    };

    const result = buildThreadPanelVisibleRows({
      collapsedGroupIds: {},
      limitsBySectionKey: {},
      view,
    });

    expect(result.rows.map((row) => row.id)).toEqual([
      'folder:root-1',
      'thread-a',
      'folder-unassigned',
      'thread-b',
    ]);
    expect(result.rows[0]).toMatchObject({
      collapsed: false,
      header: { folder, kind: 'folder' },
      kind: 'group',
      sectionKey: 'folder:root-1',
      totalCount: 1,
    });
    expect(result.rows[1]).toMatchObject({ parentId: 'folder:root-1' });
    expect(result.rows[3]).toMatchObject({ parentId: 'folder-unassigned' });
    expect(result.visibleThreadIds).toEqual(['thread-a', 'thread-b']);
  });

  it('collapses and discloses folder sections through their own section keys', () => {
    const folder: ThreadFolderRow = { displayName: 'work', path: null, rootId: 'root-2' };
    const view: ThreadListView = {
      kind: 'folders',
      sections: [
        {
          header: { folder, kind: 'folder' },
          id: folderSectionId(folder.rootId),
          threads: Array.from({ length: 60 }, (_, index) => thread(`f-${index}`)),
        },
      ],
    };

    const disclosed = buildThreadPanelVisibleRows({
      collapsedGroupIds: {},
      limitsBySectionKey: {},
      view,
    });
    expect(disclosed.visibleThreadIds).toHaveLength(50);
    expect(disclosed.rows.at(-1)).toMatchObject({
      id: 'show-more:folder:root-2',
      kind: 'show-more',
      remainingCount: 10,
      sectionKey: 'folder:root-2',
    });

    const collapsed = buildThreadPanelVisibleRows({
      collapsedGroupIds: { 'folder:root-2': true },
      limitsBySectionKey: {},
      view,
    });
    expect(collapsed.rows).toHaveLength(1);
    expect(collapsed.rows[0]).toMatchObject({ collapsed: true, totalCount: 60 });
    expect(collapsed.visibleThreadIds).toEqual([]);
  });

  it('refuses a folder section id it did not mint instead of rendering it as a node', () => {
    const view: ThreadListView = {
      kind: 'folders',
      sections: [
        { header: { kind: 'unassigned' }, id: 'somewhere-else', threads: [thread('thread-a')] },
      ],
    };

    expect(() =>
      buildThreadPanelVisibleRows({ collapsedGroupIds: {}, limitsBySectionKey: {}, view })
    ).toThrow(/somewhere-else/);
  });
});

describe('thread panel section addresses', () => {
  function groupRow(header: ThreadPanelGroupRow['header'], id: ThreadPanelGroupRow['id']) {
    return {
      collapsed: false,
      header,
      id,
      kind: 'group',
      sectionKey: id,
      totalCount: 0,
    } satisfies ThreadPanelGroupRow;
  }

  it('addresses custom groups by group id and Ungrouped by null', () => {
    const customGroup = group('group-a');
    const row = groupRow({ group: customGroup, kind: 'group' }, 'group:group-a');
    expect(getThreadPanelMemberSectionId(row)).toBe('group-a');
    expect(getThreadPanelCollapseId(row)).toBe('group-a');

    const ungrouped = groupRow({ kind: 'ungrouped' }, 'group:ungrouped');
    expect(getThreadPanelMemberSectionId(ungrouped)).toBeNull();
    expect(getThreadPanelCollapseId(ungrouped)).toBe('group:ungrouped');
  });

  it('addresses folder sections by their section id, never by a group id', () => {
    const folder: ThreadFolderRow = { displayName: 'work', path: null, rootId: 'root-2' };
    const row = groupRow({ folder, kind: 'folder' }, 'folder:root-2');
    expect(getThreadPanelMemberSectionId(row)).toBe('folder:root-2');
    expect(getThreadPanelCollapseId(row)).toBe('folder:root-2');

    const unassigned = groupRow({ kind: 'unassigned' }, UNASSIGNED_FOLDER_SECTION_ID);
    expect(getThreadPanelMemberSectionId(unassigned)).toBe('folder-unassigned');
    expect(getThreadPanelCollapseId(unassigned)).toBe('folder-unassigned');
  });
});

describe('getThreadPanelRowHeightPx', () => {
  it('gives every row kind the height it actually paints', () => {
    // Measured in the running renderer (303.5px and 218.5px panel width), not
    // derived from the Tailwind classes: group header 40, drop-zone/empty 40,
    // thread 32, show-more 36. One blanket estimate mis-sizes three of the four.
    expect(getThreadPanelRowHeightPx('group')).toBe(40);
    expect(getThreadPanelRowHeightPx('empty')).toBe(40);
    expect(getThreadPanelRowHeightPx('show-more')).toBe(36);
    expect(getThreadPanelRowHeightPx('thread')).toBe(THREAD_CONTROL_ROW_PITCH_PX);
    expect(getThreadPanelRowHeightPx('thread')).toBe(32);
  });

  it('keeps the thread estimate tied to the shared control pitch', () => {
    // If the density contract moves, the estimate must move with it rather than
    // drifting back into a magic number.
    expect(getThreadPanelRowHeightPx('thread')).toBe(THREAD_CONTROL_ROW_PITCH_PX);
    expect(getThreadPanelRowHeightPx('group')).not.toBe(THREAD_CONTROL_ROW_PITCH_PX);
  });
});

it('preserves selected ordinary threads hidden by disclosure while excluding child state rows', () => {
  const selected = filterThreadPanelSelection(
    new Set(['visible-root', 'hidden-root', 'child-state']),
    [
      {
        groupId: null,
        id: 'visible-root',
        kind: 'thread',
        parentId: null,
        thread: thread('visible-root'),
      },
      {
        depth: 1,
        groupId: null,
        id: 'child-state',
        isError: false,
        kind: 'delegated-state',
        label: 'Loading child conversations',
        parentId: 'visible-root',
      },
    ]
  );
  expect([...selected]).toEqual(['visible-root', 'hidden-root']);
});
