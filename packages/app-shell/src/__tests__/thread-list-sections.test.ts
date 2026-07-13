import { describe, expect, it } from 'vitest';
import type { AssistantMemoryThread } from '../assistant-memory-repository';
import type {
  AssistantThreadGroup,
  AssistantThreadPlacement,
} from '../assistant-thread-groups-repository';
import { buildThreadListSections } from '../thread-list-sections';

function makeThread(overrides: {
  id: string;
  title?: string;
  updatedAt?: string;
}): AssistantMemoryThread {
  return {
    createdAt: new Date('2026-07-01T00:00:00Z'),
    id: overrides.id,
    resourceId: 'workspace-a',
    title: overrides.title ?? overrides.id,
    updatedAt: new Date(overrides.updatedAt ?? '2026-07-01T00:00:00Z'),
  };
}

function makeGroup(overrides: { id: string; name?: string; rank: string }): AssistantThreadGroup {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    rank: overrides.rank,
    resourceId: 'workspace-a',
  };
}

function makePlacement(overrides: {
  threadId: string;
  groupId: string | null;
  rank: string;
}): AssistantThreadPlacement {
  return {
    groupId: overrides.groupId,
    rank: overrides.rank,
    resourceId: 'workspace-a',
    threadId: overrides.threadId,
  };
}

describe('buildThreadListSections', () => {
  it('returns a flat recency list when no groups exist', () => {
    const view = buildThreadListSections({
      groupBy: 'custom-groups',
      groups: [],
      placements: [],
      sortBy: 'recency',
      threads: [
        makeThread({ id: 'thread-old', updatedAt: '2026-07-01T00:00:00Z' }),
        makeThread({ id: 'thread-new', updatedAt: '2026-07-10T00:00:00Z' }),
      ],
    });

    expect(view.kind).toBe('flat');
    if (view.kind !== 'flat') {
      return;
    }
    expect(view.threads.map((thread) => thread.id)).toEqual(['thread-new', 'thread-old']);
  });

  it('returns a flat list when groupBy is none even if groups exist', () => {
    const view = buildThreadListSections({
      groupBy: 'none',
      groups: [makeGroup({ id: 'group-1', rank: 'a0' })],
      placements: [makePlacement({ groupId: 'group-1', rank: 'a0', threadId: 'thread-1' })],
      sortBy: 'recency',
      threads: [makeThread({ id: 'thread-1' })],
    });

    expect(view.kind).toBe('flat');
  });

  it('groups threads into rank-ordered sections with Ungrouped last', () => {
    const view = buildThreadListSections({
      groupBy: 'custom-groups',
      groups: [makeGroup({ id: 'group-b', rank: 'a1' }), makeGroup({ id: 'group-a', rank: 'a0' })],
      placements: [
        makePlacement({ groupId: 'group-a', rank: 'a0', threadId: 'thread-1' }),
        makePlacement({ groupId: 'group-b', rank: 'a0', threadId: 'thread-2' }),
      ],
      sortBy: 'recency',
      threads: [
        makeThread({ id: 'thread-1' }),
        makeThread({ id: 'thread-2' }),
        makeThread({ id: 'thread-3' }),
      ],
    });

    expect(view.kind).toBe('grouped');
    if (view.kind !== 'grouped') {
      return;
    }
    expect(view.sections.map((section) => section.group.id)).toEqual(['group-a', 'group-b']);
    expect(view.sections[0]?.threads.map((thread) => thread.id)).toEqual(['thread-1']);
    expect(view.sections[1]?.threads.map((thread) => thread.id)).toEqual(['thread-2']);
    expect(view.ungrouped.map((thread) => thread.id)).toEqual(['thread-3']);
  });

  it('keeps an empty group as an empty section', () => {
    const view = buildThreadListSections({
      groupBy: 'custom-groups',
      groups: [makeGroup({ id: 'group-empty', rank: 'a0' })],
      placements: [],
      sortBy: 'recency',
      threads: [makeThread({ id: 'thread-1' })],
    });

    expect(view.kind).toBe('grouped');
    if (view.kind !== 'grouped') {
      return;
    }
    expect(view.sections[0]?.threads).toEqual([]);
    expect(view.ungrouped.map((thread) => thread.id)).toEqual(['thread-1']);
  });

  it('treats a placement pointing at a deleted group as ungrouped', () => {
    const view = buildThreadListSections({
      groupBy: 'custom-groups',
      groups: [makeGroup({ id: 'group-a', rank: 'a0' })],
      placements: [makePlacement({ groupId: 'group-gone', rank: 'a0', threadId: 'thread-1' })],
      sortBy: 'recency',
      threads: [makeThread({ id: 'thread-1' })],
    });

    expect(view.kind).toBe('grouped');
    if (view.kind !== 'grouped') {
      return;
    }
    expect(view.sections[0]?.threads).toEqual([]);
    expect(view.ungrouped.map((thread) => thread.id)).toEqual(['thread-1']);
  });

  it('ignores placements for threads that no longer exist', () => {
    const view = buildThreadListSections({
      groupBy: 'custom-groups',
      groups: [makeGroup({ id: 'group-a', rank: 'a0' })],
      placements: [makePlacement({ groupId: 'group-a', rank: 'a0', threadId: 'thread-gone' })],
      sortBy: 'recency',
      threads: [makeThread({ id: 'thread-1' })],
    });

    expect(view.kind).toBe('grouped');
    if (view.kind !== 'grouped') {
      return;
    }
    expect(view.sections[0]?.threads).toEqual([]);
    expect(view.ungrouped.map((thread) => thread.id)).toEqual(['thread-1']);
  });

  it('sorts by name case-insensitively within each section', () => {
    const view = buildThreadListSections({
      groupBy: 'custom-groups',
      groups: [makeGroup({ id: 'group-a', rank: 'a0' })],
      placements: [
        makePlacement({ groupId: 'group-a', rank: 'a0', threadId: 'thread-1' }),
        makePlacement({ groupId: 'group-a', rank: 'a1', threadId: 'thread-2' }),
      ],
      sortBy: 'name',
      threads: [
        makeThread({ id: 'thread-1', title: 'zeta' }),
        makeThread({ id: 'thread-2', title: 'Alpha' }),
        makeThread({ id: 'thread-3', title: 'beta' }),
        makeThread({ id: 'thread-4', title: 'Aardvark' }),
      ],
    });

    expect(view.kind).toBe('grouped');
    if (view.kind !== 'grouped') {
      return;
    }
    expect(view.sections[0]?.threads.map((thread) => thread.title)).toEqual(['Alpha', 'zeta']);
    expect(view.ungrouped.map((thread) => thread.title)).toEqual(['Aardvark', 'beta']);
  });

  it('sorts custom by placement rank with unranked threads first by recency', () => {
    const view = buildThreadListSections({
      groupBy: 'custom-groups',
      groups: [],
      placements: [
        makePlacement({ groupId: null, rank: 'a1', threadId: 'thread-ranked-late' }),
        makePlacement({ groupId: null, rank: 'a0', threadId: 'thread-ranked-early' }),
      ],
      sortBy: 'custom',
      threads: [
        makeThread({ id: 'thread-ranked-late', updatedAt: '2026-07-11T00:00:00Z' }),
        makeThread({ id: 'thread-unranked-old', updatedAt: '2026-07-02T00:00:00Z' }),
        makeThread({ id: 'thread-ranked-early', updatedAt: '2026-07-01T00:00:00Z' }),
        makeThread({ id: 'thread-unranked-new', updatedAt: '2026-07-10T00:00:00Z' }),
      ],
    });

    expect(view.kind).toBe('flat');
    if (view.kind !== 'flat') {
      return;
    }
    expect(view.threads.map((thread) => thread.id)).toEqual([
      'thread-unranked-new',
      'thread-unranked-old',
      'thread-ranked-early',
      'thread-ranked-late',
    ]);
  });
});
