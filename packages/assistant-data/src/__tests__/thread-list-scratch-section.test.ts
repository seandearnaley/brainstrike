// @vitest-environment node
/**
 * ADR-0034 scratch threads in the Threads panel's Project grouping: every thread whose folder is
 * a scratch folder the host made for it lists in one Scratch section, not one section per folder.
 */
import { describe, expect, it } from 'vitest';
import type { AssistantMemoryThread } from '../assistant-memory-repository';
import {
  buildThreadListSections,
  folderSectionId,
  getGroupMemberIds,
  projectSectionId,
  repositorySectionId,
  SCRATCH_FOLDER_SECTION_ID,
  type ThreadFolderGroupingRow,
  type ThreadListOrdering,
  type ThreadRepositoryRow,
  UNASSIGNED_FOLDER_SECTION_ID,
} from '../thread-list-sections';

/** Recency is the fixture's `updatedAt`; nothing is pinned. */
const ordering: ThreadListOrdering = {
  lastActivityAt: (thread) => thread.updatedAt.getTime(),
  pinnedAtByThreadId: {},
};

const NO_REPOSITORIES: ReadonlyMap<string, ThreadRepositoryRow> = new Map();

// Two folders the host made for threads sent with no folder open, each named as a managed
// worktree is, beside a project and a folder whose names sort after "Scratch".
const quietOtter: ThreadFolderGroupingRow = {
  displayName: 'quiet-otter',
  path: '/profile/scratch/quiet-otter',
  projectId: null,
  projectName: null,
  rootId: 'root-quiet-otter',
  scratch: true,
  status: 'live',
};
const amberFox: ThreadFolderGroupingRow = {
  displayName: 'amber-fox',
  path: '/profile/scratch/amber-fox',
  projectId: null,
  projectName: null,
  rootId: 'root-amber-fox',
  scratch: true,
  status: 'live',
};
const rows: ReadonlyMap<string, ThreadFolderGroupingRow> = new Map([
  [quietOtter.rootId, quietOtter],
  [amberFox.rootId, amberFox],
  [
    'root-zeta',
    {
      displayName: 'zeta',
      path: '/ws/zeta',
      projectId: 'project-zeta',
      projectName: null,
      rootId: 'root-zeta',
      status: 'live',
    },
  ],
  [
    'root-zz',
    {
      displayName: 'zz-notes',
      path: '/ws/zz-notes',
      projectId: null,
      projectName: null,
      rootId: 'root-zz',
      status: 'live',
    },
  ],
]);

function thread(
  id: string,
  rootId: string | null,
  { day = 1, title = id }: { readonly day?: number; readonly title?: string } = {}
): AssistantMemoryThread {
  return {
    createdAt: new Date('2026-07-01T00:00:00Z'),
    id,
    ...(rootId === null
      ? {}
      : {
          metadata: {
            operatingRootDisplayName: 'x',
            operatingRootId: rootId,
            operatingRootPath: '/p',
          },
        }),
    resourceId: 'workspace-a',
    title,
    updatedAt: new Date(`2026-07-0${day}T00:00:00Z`),
  };
}

function folderView(
  threads: readonly AssistantMemoryThread[],
  {
    folderSortBy = 'recency',
    repositoryByThreadId = NO_REPOSITORIES,
  }: {
    readonly folderSortBy?: 'name' | 'recency';
    readonly repositoryByThreadId?: ReadonlyMap<string, ThreadRepositoryRow>;
  } = {}
) {
  const view = buildThreadListSections({
    folderRowsByRootId: rows,
    folderSortBy,
    groupBy: 'folder',
    ordering,
    repositoryByThreadId,
    threads,
  });
  if (view.kind !== 'folders') {
    throw new Error('expected folders');
  }
  return view;
}

describe('the Scratch section in folder grouping', () => {
  it('lists two scratch threads in one Scratch section, after every project and folder and before No project', () => {
    const view = folderView([
      thread('in-quiet-otter', quietOtter.rootId, { day: 1 }),
      thread('in-zeta', 'root-zeta', { day: 2 }),
      thread('in-amber-fox', amberFox.rootId, { day: 3 }),
      thread('no-folder', null, { day: 4 }),
      thread('in-zz', 'root-zz', { day: 5 }),
    ]);

    expect(view.sections.map((section) => section.id)).toEqual([
      'project:project-zeta',
      'folder:root-zz',
      SCRATCH_FOLDER_SECTION_ID,
      UNASSIGNED_FOLDER_SECTION_ID,
    ]);
    const scratch = view.sections[2];
    expect(scratch?.header).toEqual({ kind: 'scratch' });
    // One section, sorted as every folder section is: newest first here.
    expect(scratch?.threads.map(({ id }) => id)).toEqual(['in-amber-fox', 'in-quiet-otter']);
    expect(getGroupMemberIds(view, SCRATCH_FOLDER_SECTION_ID)).toEqual([
      'in-amber-fox',
      'in-quiet-otter',
    ]);
  });

  it('never lists a scratch thread in a folder section of its own, nor under a repository a listing names for it', () => {
    const repository: ThreadRepositoryRow = {
      branch: 'main',
      detached: false,
      displayName: 'amber-fox',
      folder: amberFox,
      key: '/profile/scratch/amber-fox/.git',
      path: '/profile/scratch/amber-fox',
      projectId: null,
      projectName: null,
    };
    const view = folderView(
      [thread('in-quiet-otter', quietOtter.rootId), thread('in-amber-fox', amberFox.rootId)],
      // The thread's folder became a repository's own checkout: it is still a scratch folder.
      { repositoryByThreadId: new Map([['in-amber-fox', repository]]) }
    );

    expect(view.sections.map((section) => section.id)).toEqual([SCRATCH_FOLDER_SECTION_ID]);
    expect(getGroupMemberIds(view, folderSectionId(quietOtter.rootId))).toEqual([]);
    expect(getGroupMemberIds(view, folderSectionId(amberFox.rootId))).toEqual([]);
  });

  it('sorts the Scratch section by name when folderSortBy is name', () => {
    const view = folderView(
      [
        thread('1', quietOtter.rootId, { title: 'zebra' }),
        thread('2', amberFox.rootId, { title: 'Apple' }),
      ],
      { folderSortBy: 'name' }
    );

    expect(view.sections[0]?.threads.map(({ title }) => title)).toEqual(['Apple', 'zebra']);
  });

  it('never lets the Scratch id collide with a folder, repository or project id, or read as a folder key', () => {
    for (const key of ['scratch', '-scratch', 'folder-scratch']) {
      expect([folderSectionId(key), repositorySectionId(key), projectSectionId(key)]).not.toContain(
        SCRATCH_FOLDER_SECTION_ID
      );
    }
    expect(SCRATCH_FOLDER_SECTION_ID).not.toBe(UNASSIGNED_FOLDER_SECTION_ID);
    // Collapse keys under `folder:` are pruned with their roots; the Scratch section's is kept.
    expect(SCRATCH_FOLDER_SECTION_ID.startsWith(folderSectionId(''))).toBe(false);
  });
});
