import type {
  AssistantMemoryThread,
  AssistantThreadGroup,
  ThreadListView,
} from '@brainstrike/assistant-data';
import { describe, expect, it } from 'vitest';
import { THREAD_CONTROL_ROW_PITCH_PX } from '../assistant-thread-presentation';
import {
  buildThreadPanelVisibleRows,
  getThreadPanelRowHeightPx,
  THREAD_PANEL_DISCLOSURE_INCREMENT,
  THREAD_PANEL_INITIAL_VISIBLE_LIMIT,
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
