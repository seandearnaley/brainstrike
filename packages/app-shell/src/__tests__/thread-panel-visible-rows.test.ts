import { describe, expect, it } from 'vitest';
import type { AssistantMemoryThread } from '../assistant-memory-repository';
import type { AssistantThreadGroup } from '../assistant-thread-groups-repository';
import type { ThreadListView } from '../thread-list-sections';
import {
  buildThreadPanelVisibleRows,
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
  return { color: null, id, name: id, rank: id, resourceId: 'workspace-a' };
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
          group: firstGroup,
          threads: Array.from({ length: 55 }, (_, index) => thread(`a-${index}`)),
        },
        {
          group: secondGroup,
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
          group: collapsedGroup,
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
      sections: [{ group: emptyGroup, threads: [] }],
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
      sections: [{ group: group('group-a'), threads: [thread('thread-a')] }],
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
