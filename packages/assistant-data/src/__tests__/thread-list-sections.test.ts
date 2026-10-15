// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AssistantMemoryThread } from '../assistant-memory-repository';
import type {
  AssistantThreadGroup,
  AssistantThreadPlacement,
} from '../assistant-thread-groups-repository';
import {
  buildThreadListSections,
  folderSectionId,
  getGroupMemberIds,
  getThreadPrimaryRootId,
  type ThreadFolderRow,
  UNASSIGNED_FOLDER_SECTION_ID,
} from '../thread-list-sections';

function makeThread(overrides: {
  id: string;
  operatingRootId?: string;
  title?: string;
  updatedAt?: string;
}): AssistantMemoryThread {
  return {
    createdAt: new Date('2026-07-01T00:00:00Z'),
    id: overrides.id,
    ...(overrides.operatingRootId === undefined
      ? {}
      : {
          metadata: {
            operatingRootDisplayName: 'x',
            operatingRootId: overrides.operatingRootId,
            operatingRootPath: '/p',
          },
        }),
    resourceId: 'workspace-a',
    title: overrides.title ?? overrides.id,
    updatedAt: new Date(overrides.updatedAt ?? '2026-07-01T00:00:00Z'),
  };
}

function makeGroup(overrides: { id: string; name?: string; rank: string }): AssistantThreadGroup {
  return {
    color: null,
    icon: null,
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
    flatRank: null,
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
    expect(view.sections.map((section) => section.header.group.id)).toEqual(['group-a', 'group-b']);
    expect(view.sections[0]?.threads.map((thread) => thread.id)).toEqual(['thread-1']);
    expect(view.sections[1]?.threads.map((thread) => thread.id)).toEqual(['thread-2']);
    expect(view.ungrouped.map((thread) => thread.id)).toEqual(['thread-3']);
  });

  it('buckets grouped threads without rescanning the full thread list per group', () => {
    const groupCount = 12;
    const threadCount = 120;
    let idReads = 0;
    const groups = Array.from({ length: groupCount }, (_, index) =>
      makeGroup({ id: `group-${index}`, rank: index.toString().padStart(2, '0') })
    );
    const placements = Array.from({ length: threadCount }, (_, index) =>
      makePlacement({
        groupId: `group-${index % groupCount}`,
        rank: index.toString().padStart(3, '0'),
        threadId: `thread-${index}`,
      })
    );
    const threads = Array.from({ length: threadCount }, (_, index) => {
      const id = `thread-${index}`;
      const thread = makeThread({
        id,
        updatedAt: new Date(Date.UTC(2026, 6, 1, 0, 0, 0, index)).toISOString(),
      });
      Object.defineProperty(thread, 'id', {
        get: () => {
          idReads += 1;
          return id;
        },
      });
      return thread;
    });

    const view = buildThreadListSections({
      groupBy: 'custom-groups',
      groups,
      placements,
      sortBy: 'recency',
      threads,
    });

    expect(view.kind).toBe('grouped');
    expect(idReads).toBeLessThan(threadCount * 8);
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

  it('uses flatRank for flat custom order without coupling to grouped rank', () => {
    const first = makePlacement({ groupId: null, rank: 'a0', threadId: 'thread-1' });
    const second = makePlacement({ groupId: null, rank: 'a1', threadId: 'thread-2' });
    const view = buildThreadListSections({
      groupBy: 'none',
      groups: [],
      placements: [
        { ...first, flatRank: 'z1' },
        { ...second, flatRank: 'z0' },
      ],
      sortBy: 'custom',
      threads: [makeThread({ id: 'thread-1' }), makeThread({ id: 'thread-2' })],
    });

    expect(view.kind).toBe('flat');
    if (view.kind !== 'flat') {
      return;
    }
    expect(view.threads.map((thread) => thread.id)).toEqual(['thread-2', 'thread-1']);
  });

  it('keeps grouped custom order on grouped rank when flatRank differs', () => {
    const group = makeGroup({ id: 'group-a', rank: 'a0' });
    const first = makePlacement({ groupId: group.id, rank: 'a0', threadId: 'thread-1' });
    const second = makePlacement({ groupId: group.id, rank: 'a1', threadId: 'thread-2' });
    const view = buildThreadListSections({
      groupBy: 'custom-groups',
      groups: [group],
      placements: [
        { ...first, flatRank: 'z1' },
        { ...second, flatRank: 'z0' },
      ],
      sortBy: 'custom',
      threads: [makeThread({ id: 'thread-1' }), makeThread({ id: 'thread-2' })],
    });

    expect(view.kind).toBe('grouped');
    if (view.kind !== 'grouped') {
      return;
    }
    expect(view.sections[0]?.threads.map((thread) => thread.id)).toEqual(['thread-1', 'thread-2']);
  });
});

describe('getGroupMemberIds', () => {
  it('reuses member ids while the immutable view is unchanged', () => {
    let idReads = 0;
    const threads = ['thread-1', 'thread-2'].map((id) => {
      const thread = makeThread({ id });
      Object.defineProperty(thread, 'id', {
        get: () => {
          idReads += 1;
          return id;
        },
      });
      return thread;
    });
    const view = {
      kind: 'grouped',
      sections: [
        {
          header: { group: makeGroup({ id: 'group-a', rank: 'a0' }), kind: 'group' as const },
          id: 'group-a',
          threads,
        },
      ],
      ungrouped: [],
    } as const;

    const first = getGroupMemberIds(view, 'group-a');
    const second = getGroupMemberIds(view, 'group-a');

    expect(first).toEqual(['thread-1', 'thread-2']);
    expect(second).toBe(first);
    expect(idReads).toBe(2);
  });

  it('projects only requested groups for a virtualized first render', () => {
    let idReads = 0;
    const sections = Array.from({ length: 100 }, (_, index) => {
      const id = `thread-${index}`;
      const thread = makeThread({ id });
      Object.defineProperty(thread, 'id', {
        get: () => {
          idReads += 1;
          return id;
        },
      });
      return {
        header: {
          group: makeGroup({
            id: `group-${index}`,
            rank: index.toString().padStart(3, '0'),
          }),
          kind: 'group' as const,
        },
        id: `group-${index}`,
        threads: [thread],
      };
    });
    const view = {
      kind: 'grouped',
      sections,
      ungrouped: [],
    } as const;

    const first = getGroupMemberIds(view, 'group-0');
    const repeated = getGroupMemberIds(view, 'group-0');

    expect(first).toEqual(['thread-0']);
    expect(repeated).toBe(first);
    expect(idReads).toBe(1);

    expect(getGroupMemberIds(view, 'group-99')).toEqual(['thread-99']);
    expect(idReads).toBe(2);
  });

  it('invalidates by view identity and projects ungrouped and unknown groups', () => {
    const groups = [makeGroup({ id: 'group-a', rank: 'a0' })];
    const before = buildThreadListSections({
      groupBy: 'custom-groups',
      groups,
      placements: [makePlacement({ groupId: 'group-a', rank: 'a0', threadId: 'thread-1' })],
      sortBy: 'recency',
      threads: [makeThread({ id: 'thread-1' }), makeThread({ id: 'ungrouped-1' })],
    });
    const after = buildThreadListSections({
      groupBy: 'custom-groups',
      groups,
      placements: [
        makePlacement({ groupId: 'group-a', rank: 'a0', threadId: 'thread-1' }),
        makePlacement({ groupId: 'group-a', rank: 'a1', threadId: 'thread-2' }),
      ],
      sortBy: 'recency',
      threads: [
        makeThread({ id: 'thread-1' }),
        makeThread({ id: 'thread-2' }),
        makeThread({ id: 'ungrouped-2' }),
      ],
    });

    expect(getGroupMemberIds(before, 'group-a')).toEqual(['thread-1']);
    expect(getGroupMemberIds(after, 'group-a')).toEqual(['thread-1', 'thread-2']);
    expect(getGroupMemberIds(before, 'group-a')).toEqual(['thread-1']);
    expect(getGroupMemberIds(before, null)).toEqual(['ungrouped-1']);
    expect(getGroupMemberIds(after, null)).toEqual(['ungrouped-2']);
    expect(getGroupMemberIds(after, 'unknown-group')).toEqual([]);
  });
});

describe('folder grouping', () => {
  const rows: ReadonlyMap<string, ThreadFolderRow> = new Map([
    ['root-a', { displayName: 'brainstrike', path: '/ws/brainstrike', rootId: 'root-a' }],
    ['root-b', { displayName: 'alpha', path: '/ws/alpha', rootId: 'root-b' }],
  ]);

  function folderThread(
    id: string,
    rootId: string | null,
    updatedAt: string
  ): AssistantMemoryThread {
    return makeThread({
      id,
      ...(rootId === null ? {} : { operatingRootId: rootId }),
      updatedAt,
    });
  }

  it('reads the primary root id from thread metadata and rejects a blank one', () => {
    expect(getThreadPrimaryRootId(makeThread({ id: 'thread-1', operatingRootId: 'root-a' }))).toBe(
      'root-a'
    );
    expect(getThreadPrimaryRootId(makeThread({ id: 'thread-2' }))).toBeNull();
    expect(getThreadPrimaryRootId(makeThread({ id: 'thread-3', operatingRootId: '' }))).toBeNull();
  });

  it('buckets threads by operatingRootId into folder sections sorted by name, No folder last', () => {
    const view = buildThreadListSections({
      folderRowsByRootId: rows,
      folderSortBy: 'recency',
      groupBy: 'folder',
      threads: [
        folderThread('1', 'root-a', '2026-07-01T00:00:00Z'),
        folderThread('2', 'root-b', '2026-07-02T00:00:00Z'),
        folderThread('3', null, '2026-07-03T00:00:00Z'),
        folderThread('4', 'root-a', '2026-07-04T00:00:00Z'),
      ],
    });

    expect(view.kind).toBe('folders');
    if (view.kind !== 'folders') {
      throw new Error('expected folders');
    }
    expect(view.sections.map((section) => section.id)).toEqual([
      'folder:root-b',
      'folder:root-a',
      'folder-unassigned',
    ]);
    const folderSection = view.sections[1];
    expect(folderSection?.header.kind).toBe('folder');
    if (folderSection?.header.kind !== 'folder') {
      throw new Error('expected a folder header');
    }
    expect(folderSection.header.folder.displayName).toBe('brainstrike');
    expect(folderSection.threads.map((thread) => thread.id)).toEqual(['4', '1']);
    expect(view.sections[2]?.header.kind).toBe('unassigned');
    expect(view.sections[2]?.threads.map((thread) => thread.id)).toEqual(['3']);
  });

  it('omits the No folder section when every thread is bound, and sends unknown root ids there', () => {
    const bound = buildThreadListSections({
      folderRowsByRootId: rows,
      folderSortBy: 'recency',
      groupBy: 'folder',
      threads: [folderThread('1', 'root-a', '2026-07-01T00:00:00Z')],
    });

    expect(bound.kind).toBe('folders');
    if (bound.kind !== 'folders') {
      throw new Error('expected folders');
    }
    expect(bound.sections.map((section) => section.id)).toEqual(['folder:root-a']);

    const unknown = buildThreadListSections({
      folderRowsByRootId: rows,
      folderSortBy: 'recency',
      groupBy: 'folder',
      threads: [folderThread('1', 'root-zzz', '2026-07-01T00:00:00Z')],
    });

    expect(unknown.kind).toBe('folders');
    if (unknown.kind !== 'folders') {
      throw new Error('expected folders');
    }
    expect(unknown.sections.map((section) => section.id)).toEqual(['folder-unassigned']);
  });

  it('sorts threads inside a folder by name when folderSortBy is name', () => {
    const view = buildThreadListSections({
      folderRowsByRootId: rows,
      folderSortBy: 'name',
      groupBy: 'folder',
      threads: [
        makeThread({ id: '1', operatingRootId: 'root-a', title: 'zeta' }),
        makeThread({ id: '2', operatingRootId: 'root-a', title: 'Alpha' }),
        makeThread({ id: '3', title: 'beta' }),
        makeThread({ id: '4', title: 'Aardvark' }),
      ],
    });

    expect(view.kind).toBe('folders');
    if (view.kind !== 'folders') {
      throw new Error('expected folders');
    }
    expect(view.sections[0]?.threads.map((thread) => thread.title)).toEqual(['Alpha', 'zeta']);
    expect(view.sections[1]?.threads.map((thread) => thread.title)).toEqual(['Aardvark', 'beta']);
  });

  // The folder arm of the input union is what enforces folder mode's contract:
  // the compiler rejects both shapes below, so there is no runtime guard left
  // to exercise. `@ts-expect-error` fails the type-check if either ever starts
  // compiling again.
  it('accepts no group inputs in folder mode and demands folder rows, at compile time', () => {
    const ignoringGroups = buildThreadListSections({
      folderRowsByRootId: rows,
      folderSortBy: 'recency',
      groupBy: 'folder',
      // @ts-expect-error -- folder grouping ignores custom groups, so it takes none.
      groups: [makeGroup({ id: 'group-a', rank: 'a0' })],
      threads: [folderThread('1', 'root-a', '2026-07-01T00:00:00Z')],
    });
    expect(ignoringGroups.kind).toBe('folders');
    if (ignoringGroups.kind !== 'folders') {
      throw new Error('expected folders');
    }
    expect(ignoringGroups.sections.map((section) => section.id)).toEqual(['folder:root-a']);

    // @ts-expect-error -- folder grouping requires folder rows and a folder sort.
    const missingRows = buildThreadListSections({ groupBy: 'folder', threads: [] });
    expect(missingRows.kind).toBe('folders');
  });

  it('getGroupMemberIds answers folder section ids and folder-unassigned', () => {
    const view = buildThreadListSections({
      folderRowsByRootId: rows,
      folderSortBy: 'recency',
      groupBy: 'folder',
      threads: [
        folderThread('1', 'root-a', '2026-07-01T00:00:00Z'),
        folderThread('2', null, '2026-07-02T00:00:00Z'),
      ],
    });

    const members = getGroupMemberIds(view, 'folder:root-a');
    expect(members).toEqual(['1']);
    expect(getGroupMemberIds(view, 'folder:root-a')).toBe(members);
    expect(getGroupMemberIds(view, 'folder-unassigned')).toEqual(['2']);
    expect(getGroupMemberIds(view, 'folder:root-unknown')).toEqual([]);
    expect(getGroupMemberIds(view, null)).toEqual([]);
  });

  it('never lets a root literally named "unassigned" collide with the No folder sentinel', () => {
    expect(folderSectionId('unassigned')).not.toBe(UNASSIGNED_FOLDER_SECTION_ID);
  });
});
