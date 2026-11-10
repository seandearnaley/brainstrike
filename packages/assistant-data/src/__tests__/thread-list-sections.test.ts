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
  getThreadDateSection,
  getThreadLastActivityAt,
  getThreadPrimaryRootId,
  repositorySectionId,
  type ThreadFolderRow,
  type ThreadListOrdering,
  type ThreadRepositoryRow,
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

/** Recency is the fixture's `updatedAt`; nothing is pinned. */
const ordering: ThreadListOrdering = {
  lastActivityAt: (thread) => thread.updatedAt.getTime(),
  pinnedAtByThreadId: {},
};

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
      ordering,
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
      ordering,
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
      ordering,
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
      ordering,
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
      ordering,
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
      ordering,
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
      ordering,
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
      ordering,
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
      ordering,
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
      ordering,
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
      ordering,
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
      pinned: null,
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
      pinned: null,
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
      ordering,
      placements: [makePlacement({ groupId: 'group-a', rank: 'a0', threadId: 'thread-1' })],
      sortBy: 'recency',
      threads: [makeThread({ id: 'thread-1' }), makeThread({ id: 'ungrouped-1' })],
    });
    const after = buildThreadListSections({
      groupBy: 'custom-groups',
      groups,
      ordering,
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

/** No thread's folder is a repository's checkout: every thread groups by its folder. */
const NO_REPOSITORIES: ReadonlyMap<string, ThreadRepositoryRow> = new Map();

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
      ordering,
      repositoryByThreadId: NO_REPOSITORIES,
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
      ordering,
      repositoryByThreadId: NO_REPOSITORIES,
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
      ordering,
      repositoryByThreadId: NO_REPOSITORIES,
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
      ordering,
      repositoryByThreadId: NO_REPOSITORIES,
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
      ordering,
      repositoryByThreadId: NO_REPOSITORIES,
      threads: [folderThread('1', 'root-a', '2026-07-01T00:00:00Z')],
    });
    expect(ignoringGroups.kind).toBe('folders');
    if (ignoringGroups.kind !== 'folders') {
      throw new Error('expected folders');
    }
    expect(ignoringGroups.sections.map((section) => section.id)).toEqual(['folder:root-a']);

    // @ts-expect-error -- folder grouping requires folder rows and a folder sort.
    const missingRows = buildThreadListSections({ groupBy: 'folder', ordering, threads: [] });
    expect(missingRows.kind).toBe('folders');
  });

  it('getGroupMemberIds answers folder section ids and folder-unassigned', () => {
    const view = buildThreadListSections({
      folderRowsByRootId: rows,
      folderSortBy: 'recency',
      groupBy: 'folder',
      ordering,
      repositoryByThreadId: NO_REPOSITORIES,
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

describe('repository sections in folder grouping', () => {
  const checkout: ThreadFolderRow = {
    displayName: 'brainstrike',
    path: '/ws/brainstrike',
    rootId: 'root-a',
  };
  const rows: ReadonlyMap<string, ThreadFolderRow> = new Map([
    ['root-a', checkout],
    ['root-b', { displayName: 'alpha', path: '/ws/alpha', rootId: 'root-b' }],
    ['root-wt', { displayName: 'swift-badger', path: '/wt/swift-badger', rootId: 'root-wt' }],
  ]);
  const repository: ThreadRepositoryRow = {
    branch: 'main',
    commonDir: '/ws/brainstrike/.git',
    detached: false,
    displayName: 'brainstrike',
    folder: checkout,
    path: '/ws/brainstrike',
  };

  function at(id: string, rootId: string | null, day: number): AssistantMemoryThread {
    return makeThread({
      id,
      ...(rootId === null ? {} : { operatingRootId: rootId }),
      updatedAt: `2026-07-0${day}T00:00:00Z`,
    });
  }

  it('puts a thread working in a worktree under its repository, beside the threads in its own checkout', () => {
    const view = buildThreadListSections({
      folderRowsByRootId: rows,
      folderSortBy: 'recency',
      groupBy: 'folder',
      ordering,
      repositoryByThreadId: new Map([
        ['local', repository],
        ['worktree', repository],
      ]),
      threads: [
        at('local', 'root-a', 1),
        at('worktree', 'root-wt', 2),
        at('other-folder', 'root-b', 3),
        at('no-folder', null, 4),
      ],
    });

    if (view.kind !== 'folders') {
      throw new Error('expected folders');
    }
    // One section for the repository, not one for its checkout and one for the worktree.
    expect(view.sections.map((section) => section.id)).toEqual([
      'folder:root-b',
      'repository:/ws/brainstrike/.git',
      'folder-unassigned',
    ]);
    const section = view.sections[1];
    if (section?.header.kind !== 'repository') {
      throw new Error('expected a repository header');
    }
    expect(section.header.repository).toBe(repository);
    expect(section.threads.map((thread) => thread.id)).toEqual(['worktree', 'local']);
    expect(getGroupMemberIds(view, repositorySectionId('/ws/brainstrike/.git'))).toEqual([
      'worktree',
      'local',
    ]);
  });

  it('keeps a folder that is no repository checkout as its own section', () => {
    const view = buildThreadListSections({
      folderRowsByRootId: rows,
      folderSortBy: 'recency',
      groupBy: 'folder',
      ordering,
      // The worktree's thread has no repository here: the ledger or git no longer joins it.
      repositoryByThreadId: new Map([['local', repository]]),
      threads: [at('local', 'root-a', 1), at('worktree', 'root-wt', 2)],
    });

    if (view.kind !== 'folders') {
      throw new Error('expected folders');
    }
    expect(view.sections.map((section) => section.id)).toEqual([
      'repository:/ws/brainstrike/.git',
      'folder:root-wt',
    ]);
  });

  it('lists a repository whose worktree folder has no folder row of its own', () => {
    const view = buildThreadListSections({
      folderRowsByRootId: new Map(),
      folderSortBy: 'recency',
      groupBy: 'folder',
      ordering,
      repositoryByThreadId: new Map([['worktree', { ...repository, folder: null }]]),
      threads: [at('worktree', 'root-wt', 1)],
    });

    if (view.kind !== 'folders') {
      throw new Error('expected folders');
    }
    // Under its repository, never under "No folder": the thread has a folder.
    expect(view.sections.map((section) => section.id)).toEqual(['repository:/ws/brainstrike/.git']);
  });

  it('never lets a folder id collide with a repository id', () => {
    expect(repositorySectionId('root-a')).not.toBe(folderSectionId('root-a'));
  });
});

describe('recency, date sections and pins', () => {
  // A local Tuesday afternoon, so every boundary below is a local midnight.
  const now = new Date(2026, 9, 27, 15, 0, 0);
  const at = (days: number, hours = 12): Date =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, hours);

  it('reads activity from the latest run, never from a rename or recolor', () => {
    const thread = { createdAt: at(40) };
    expect(getThreadLastActivityAt(thread, undefined)).toBe(at(40).getTime());
    expect(getThreadLastActivityAt(thread, { completedAt: at(2, 9), startedAt: at(2, 8) })).toBe(
      at(2, 9).getTime()
    );
    // A run still going counts from its start.
    expect(getThreadLastActivityAt(thread, { completedAt: null, startedAt: at(0, 1) })).toBe(
      at(0, 1).getTime()
    );
  });

  it('names recent days, then months, with the year only when it differs', () => {
    const label = (date: Date) => getThreadDateSection(date.getTime(), now);
    expect(label(at(0, 0))).toEqual({ id: 'date:today', label: 'Today' });
    expect(label(new Date(now.getTime() + 60_000)).id).toBe('date:today');
    expect(label(at(1, 23)).id).toBe('date:yesterday');
    expect(label(at(7, 0)).id).toBe('date:previous-7-days');
    expect(label(at(8)).id).toBe('date:previous-30-days');
    expect(label(at(30, 0)).id).toBe('date:previous-30-days');
    expect(label(new Date(2026, 7, 3)).id).toBe('date:2026-08');
    expect(label(new Date(2025, 11, 3))).toEqual({
      id: 'date:2025-12',
      label: new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(
        new Date(2025, 11, 3)
      ),
    });
  });

  it('groups by date newest first and lifts pins above every section', () => {
    const threads = [
      makeThread({ id: 'old', updatedAt: new Date(2026, 7, 3).toISOString() }),
      makeThread({ id: 'today', updatedAt: at(0, 9).toISOString() }),
      makeThread({ id: 'pinned-old', updatedAt: new Date(2026, 6, 1).toISOString() }),
      makeThread({ id: 'week', updatedAt: at(3).toISOString() }),
      makeThread({ id: 'pinned-new', updatedAt: at(1).toISOString() }),
      makeThread({ id: 'today-later', updatedAt: at(0, 14).toISOString() }),
    ];
    const view = buildThreadListSections({
      groupBy: 'date',
      now,
      ordering: { ...ordering, pinnedAtByThreadId: { 'pinned-new': 1, 'pinned-old': 2 } },
      threads,
    });
    if (view.kind !== 'dates') {
      throw new Error('expected dates');
    }
    expect(view.pinned?.threads.map((thread) => thread.id)).toEqual(['pinned-old', 'pinned-new']);
    expect(
      view.sections.map((section) => [section.id, section.threads.map((thread) => thread.id)])
    ).toEqual([
      ['date:today', ['today-later', 'today']],
      ['date:previous-7-days', ['week']],
      ['date:2026-08', ['old']],
    ]);
    expect(getGroupMemberIds(view, 'pinned')).toEqual(['pinned-old', 'pinned-new']);
  });

  it('lists pinned threads first in the flat list, and out of their custom group', () => {
    const pinnedOrdering = { ...ordering, pinnedAtByThreadId: { b: 5 } };
    const threads = [
      makeThread({ id: 'a', updatedAt: '2026-07-03T00:00:00Z' }),
      makeThread({ id: 'b', updatedAt: '2026-07-01T00:00:00Z' }),
    ];
    const flat = buildThreadListSections({
      groupBy: 'none',
      groups: [],
      ordering: pinnedOrdering,
      placements: [],
      sortBy: 'recency',
      threads,
    });
    expect(flat.kind === 'flat' && flat.threads.map((thread) => thread.id)).toEqual(['b', 'a']);
    const grouped = buildThreadListSections({
      groupBy: 'custom-groups',
      groups: [makeGroup({ id: 'g', rank: 'a0' })],
      ordering: pinnedOrdering,
      placements: [makePlacement({ groupId: 'g', rank: 'a0', threadId: 'b' })],
      sortBy: 'recency',
      threads,
    });
    if (grouped.kind !== 'grouped') {
      throw new Error('expected grouped');
    }
    expect(grouped.pinned?.threads.map((thread) => thread.id)).toEqual(['b']);
    expect(grouped.sections[0]?.threads).toEqual([]);
  });
});
