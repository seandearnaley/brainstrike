// @vitest-environment node
import type { AssistantMemoryThread, ThreadFolderRow } from '@brainstrike/assistant-data';
import type { WorktreeListEntry } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { projectThreadRepositories, resolveThreadRepository } from '../thread-repositories';

const COMMON_DIR = '/code/brainstrike/.git';

function entry(
  overrides: Partial<WorktreeListEntry> & { readonly path: string }
): WorktreeListEntry {
  return {
    branch: 'main',
    containment: 'outside-roots',
    createdAt: null,
    detached: false,
    disabledReason: null,
    externalTool: null,
    id: null,
    lockedReason: null,
    managed: false,
    name: overrides.path.split('/').at(-1) ?? overrides.path,
    primary: false,
    provenance: 'scanned',
    remedy: null,
    repoCommonDir: COMMON_DIR,
    repositoryRoot: '/code/brainstrike',
    rootId: null,
    rootIdIsExactMount: false,
    setupReason: null,
    setupStatus: 'none',
    trust: 'validated',
    trustReason: null,
    usable: true,
    ...overrides,
  };
}

const ownCheckout = entry({
  path: '/code/brainstrike',
  primary: true,
  rootId: 'root-repo',
  rootIdIsExactMount: true,
});
const managedWorktree = entry({
  branch: 'swift-badger',
  id: 'wt-1',
  managed: true,
  path: '/worktrees/swift-badger',
  provenance: 'both',
  rootId: 'root-wt',
  rootIdIsExactMount: true,
});

const repoFolder: ThreadFolderRow = {
  displayName: 'brainstrike',
  path: '/code/brainstrike',
  rootId: 'root-repo',
};
const folderRows: ReadonlyMap<string, ThreadFolderRow> = new Map([['root-repo', repoFolder]]);

function thread(id: string, metadata?: AssistantMemoryThread['metadata']): AssistantMemoryThread {
  return {
    createdAt: new Date('2026-11-01T00:00:00Z'),
    id,
    ...(metadata === undefined ? {} : { metadata }),
    resourceId: 'workspace',
    title: id,
    updatedAt: new Date('2026-11-01T00:00:00Z'),
  };
}

const inWorktree = thread('in-worktree', {
  checkoutLocalRootId: 'root-repo',
  checkoutMode: 'worktree',
  checkoutWorktreeId: 'wt-1',
  checkoutWorktreePath: '/worktrees/swift-badger',
  operatingRootDisplayName: 'swift-badger',
  operatingRootId: 'root-wt',
  operatingRootPath: '/worktrees/swift-badger',
});
const inOwnCheckout = thread('in-own-checkout', {
  operatingRootDisplayName: 'brainstrike',
  operatingRootId: 'root-repo',
  operatingRootPath: '/code/brainstrike',
});

describe('projectThreadRepositories', () => {
  it("names one repository for its own checkout's threads and its managed worktree's", () => {
    const lookup = projectThreadRepositories([ownCheckout, managedWorktree], folderRows);

    const repository = resolveThreadRepository(inOwnCheckout, lookup);
    expect(repository).toEqual({
      branch: 'main',
      commonDir: COMMON_DIR,
      detached: false,
      displayName: 'brainstrike',
      folder: repoFolder,
      path: '/code/brainstrike',
    });
    // The same repository, so the two threads share one section.
    expect(resolveThreadRepository(inWorktree, lookup)).toBe(repository);
  });

  it("finds a worktree thread's repository by the ledger id its binding names, while the worktree's folder is not open", () => {
    const lookup = projectThreadRepositories(
      [ownCheckout, { ...managedWorktree, rootId: null, rootIdIsExactMount: false }],
      folderRows
    );

    expect(resolveThreadRepository(inWorktree, lookup)?.commonDir).toBe(COMMON_DIR);
  });

  it('leaves a worktree out of its repository unless the ledger lists it and git joins it', () => {
    const cases: readonly WorktreeListEntry[] = [
      // Git's links do not join it to this repository.
      { ...managedWorktree, trust: 'unvalidated', trustReason: 'points at another common dir' },
      // The ledger does not list it: a worktree the person made and opened as a folder.
      { ...managedWorktree, id: null, managed: false, provenance: 'scanned' },
      // The ledger lists it but nothing is on disk.
      { ...managedWorktree, provenance: 'agent-reported', trust: 'unvalidated' },
    ];
    for (const worktree of cases) {
      const lookup = projectThreadRepositories([ownCheckout, worktree], folderRows);
      expect(resolveThreadRepository(inWorktree, lookup)).toBeUndefined();
      // Its repository's own checkout is unaffected.
      expect(resolveThreadRepository(inOwnCheckout, lookup)?.commonDir).toBe(COMMON_DIR);
    }
  });

  it('keeps a folder that only contains a repository as a folder of its own', () => {
    // `root-parent` is /code: it holds the checkout but is not the checkout.
    const lookup = projectThreadRepositories(
      [{ ...ownCheckout, rootId: 'root-parent', rootIdIsExactMount: false }],
      folderRows
    );
    const inParent = thread('in-parent', {
      operatingRootDisplayName: 'code',
      operatingRootId: 'root-parent',
      operatingRootPath: '/code',
    });

    expect(resolveThreadRepository(inParent, lookup)).toBeUndefined();
  });

  it("names a repository by its checkout's folder name and offers no folder while that checkout is not open", () => {
    const lookup = projectThreadRepositories(
      [
        { ...ownCheckout, branch: null, detached: true, rootId: null, rootIdIsExactMount: false },
        managedWorktree,
      ],
      new Map()
    );

    expect(resolveThreadRepository(inWorktree, lookup)).toEqual({
      branch: null,
      commonDir: COMMON_DIR,
      detached: true,
      displayName: 'brainstrike',
      folder: null,
      path: '/code/brainstrike',
    });
  });

  it('resolves nothing for a thread with no folder', () => {
    const lookup = projectThreadRepositories([ownCheckout, managedWorktree], folderRows);

    expect(resolveThreadRepository(thread('no-folder'), lookup)).toBeUndefined();
  });
});
