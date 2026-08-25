import type { GitInventory } from '@brainstrike/types';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useGitInventoryMock } = vi.hoisted(() => ({ useGitInventoryMock: vi.fn() }));
vi.mock('../changes/use-git-inventory', () => ({ useGitInventory: useGitInventoryMock }));

import {
  projectBranchesForTest,
  useThreadBranchByRootPath,
} from '../hooks/use-thread-branch-by-root-path';

type Worktree = GitInventory['repositories'][number]['worktrees'][number];

function worktree(
  path: string,
  branch: string | null,
  detached: boolean,
  containment: Worktree['containment'] = ['root-a'],
  bare = false
): Worktree {
  return {
    bare,
    branch,
    containment,
    current: false,
    detached,
    head: 'abc1234',
    lockedReason: null,
    name: path,
    path,
    provenance: 'scanned',
    prunableReason: null,
    trust: 'validated',
    trustReason: null,
  };
}

const INVENTORY: GitInventory = {
  errors: [],
  repositories: [
    {
      identity: { gitCommonDir: '/work/a/.git', repositoryRoot: '/work/a' },
      worktrees: [
        worktree('/work/a', 'main', false),
        // Trailing separator + detached: both normalization and the detached
        // flag have to survive the projection.
        worktree('/work/a-wt/', null, true),
      ],
    },
  ],
};

/**
 * One root, one worktree, and a MOUNTED path (`/var/...`) that git never
 * reports because it resolves the symlink (`/private/var/...`). Only the
 * containment id joins.
 */
const SYMLINKED_ROOT_INVENTORY: GitInventory = {
  errors: [],
  repositories: [
    {
      identity: {
        gitCommonDir: '/private/var/folders/tmp/repo/.git',
        repositoryRoot: '/private/var/folders/tmp/repo',
      },
      worktrees: [worktree('/private/var/folders/tmp/repo', 'main', false, ['root-symlinked'])],
    },
  ],
};

function mockInventory(inventory: GitInventory | null, available = true): void {
  useGitInventoryMock.mockReturnValue({
    available,
    error: null,
    inventory,
    loading: false,
    refresh: vi.fn(),
  });
}

beforeEach(() => {
  useGitInventoryMock.mockReset();
});

describe('useThreadBranchByRootPath', () => {
  it('maps every worktree path to its branch and detached flag', () => {
    mockInventory(INVENTORY);

    const { result } = renderHook(() => useThreadBranchByRootPath({ enabled: true }));

    expect(result.current.available).toBe(true);
    expect(result.current.byRootPath.get('/work/a')).toEqual({
      branch: 'main',
      detached: false,
      gitCommonDir: '/work/a/.git',
    });
    expect(result.current.byRootPath.get('/work/a-wt')).toEqual({
      branch: null,
      detached: true,
      gitCommonDir: '/work/a/.git',
    });
    expect(result.current.byRootPath.size).toBe(2);
  });

  // The inventory load is a FULL repo/worktree scan across every workspace
  // root (BST-1116 W6 finding 4). Branch chips only exist in folders grouping,
  // so an ungated hook makes every Threads-panel mount in EVERY grouping mode
  // pay for it.
  it('defers the inventory scan while disabled', () => {
    mockInventory(null);

    renderHook(() => useThreadBranchByRootPath({ enabled: false }));

    expect(useGitInventoryMock.mock.calls[0]?.[0]).toEqual({
      active: false,
      deferInitialLoad: true,
    });
  });

  it('requests the scan once enabled', () => {
    mockInventory(INVENTORY);

    renderHook(() => useThreadBranchByRootPath({ enabled: true }));

    expect(useGitInventoryMock.mock.calls[0]?.[0]).toEqual({
      active: true,
      deferInitialLoad: false,
    });
  });

  it('reports unavailable with an empty map on web, where there is no bridge', () => {
    mockInventory(null, false);

    const { result } = renderHook(() => useThreadBranchByRootPath({ enabled: true }));

    expect(result.current.available).toBe(false);
    expect(result.current.byRootPath.size).toBe(0);
  });

  it('reports an empty map while the inventory is still unresolved', () => {
    mockInventory(null);

    const { result } = renderHook(() => useThreadBranchByRootPath({ enabled: true }));

    expect(result.current.available).toBe(true);
    expect(result.current.byRootPath.size).toBe(0);
  });

  it('memoizes the map on inventory identity', () => {
    mockInventory(INVENTORY);
    const { rerender, result } = renderHook(() => useThreadBranchByRootPath({ enabled: true }));
    const first = result.current.byRootPath;

    rerender();

    expect(result.current.byRootPath).toBe(first);
  });

  // A bare worktree is `branch: null, detached: false` — neither half of what
  // a chip can say. Mapped, it becomes a `ThreadBranchInfo` the row renders as
  // an icon with NO text: an empty pill. Absent, the row renders no chip, which
  // is the same rule this map already applies to every other unknown.
  it('omits a bare worktree, which has no branch to report', () => {
    mockInventory({
      errors: [],
      repositories: [
        {
          identity: { gitCommonDir: '/work/bare.git', repositoryRoot: '/work/bare.git' },
          worktrees: [
            worktree('/work/bare.git', null, false, ['root-a'], true),
            worktree('/work/b', 'dev', false),
          ],
        },
      ],
    });

    const { result } = renderHook(() => useThreadBranchByRootPath({ enabled: true }));

    expect(result.current.byRootPath.has('/work/bare.git')).toBe(false);
    expect(result.current.byRootPath.get('/work/b')).toEqual({
      branch: 'dev',
      detached: false,
      gitCommonDir: '/work/bare.git',
    });
    // ...and being skipped, it does not make its root's containment ambiguous:
    // the one worktree that DOES have a branch still answers for `root-a`.
    expect(result.current.byRootId.get('root-a')).toEqual({
      branch: 'dev',
      detached: false,
      gitCommonDir: '/work/bare.git',
    });
  });

  // Exact-path matching only: a root that merely CONTAINS worktrees has no
  // branch of its own and must not borrow one.
  it('yields nothing for a workspace root that only contains worktrees', () => {
    mockInventory(INVENTORY);

    const { result } = renderHook(() => useThreadBranchByRootPath({ enabled: true }));

    expect(result.current.byRootPath.has('/work')).toBe(false);
    expect(result.current.byRootPath.has('root-a')).toBe(false);
  });

  // The symlink case the exact-path join cannot answer (found by W2 task 5's
  // e2e run): `roots.path` is the MOUNTED path, git reports the REALPATH, so
  // `/var/...` never equals `/private/var/...` and the chip silently vanished.
  // `containment` carries DB `roots.id` computed in main against realpath'd
  // paths, so the id join answers it.
  it('resolves a root whose mounted path differs from the realpath git reports', () => {
    mockInventory(SYMLINKED_ROOT_INVENTORY);

    const { result } = renderHook(() => useThreadBranchByRootPath({ enabled: true }));

    // The mounted path the panel would join on is absent — that is the defect.
    expect(result.current.byRootPath.has('/var/folders/tmp/repo')).toBe(false);
    expect(result.current.byRootId.get('root-symlinked')).toEqual({
      branch: 'main',
      detached: false,
      gitCommonDir: '/private/var/folders/tmp/repo/.git',
    });
  });

  // Two worktrees inside one root is exactly why containment was rejected as
  // the PRIMARY key: the root has no branch of its own, and picking one of the
  // two would be a fabricated chip.
  it('refuses an ambiguous containment rather than guessing a branch', () => {
    mockInventory(INVENTORY);

    const { result } = renderHook(() => useThreadBranchByRootPath({ enabled: true }));

    expect(result.current.byRootId.has('root-a')).toBe(false);
    expect(result.current.byRootId.size).toBe(0);
  });

  it('omits a worktree that sits outside every workspace root', () => {
    mockInventory({
      errors: [],
      repositories: [
        {
          identity: { gitCommonDir: '/elsewhere/.git', repositoryRoot: '/elsewhere' },
          worktrees: [worktree('/elsewhere', 'main', false, 'outside-roots')],
        },
      ],
    });

    const { result } = renderHook(() => useThreadBranchByRootPath({ enabled: true }));

    expect(result.current.byRootId.size).toBe(0);
    expect(result.current.byRootPath.get('/elsewhere')).toEqual({
      branch: 'main',
      detached: false,
      gitCommonDir: '/elsewhere/.git',
    });
  });

  it('memoizes the id map on inventory identity', () => {
    mockInventory(SYMLINKED_ROOT_INVENTORY);
    const { rerender, result } = renderHook(() => useThreadBranchByRootPath({ enabled: true }));
    const first = result.current.byRootId;
    expect(first.size).toBe(1);

    rerender();

    expect(result.current.byRootId).toBe(first);
  });

  it('reports an empty id map while the inventory is still unresolved', () => {
    mockInventory(null);

    const { result } = renderHook(() => useThreadBranchByRootPath({ enabled: true }));

    expect(result.current.byRootId.size).toBe(0);
  });
});

describe('ThreadBranchInfo repository identity', () => {
  it('projects the repository common directory with the branch', () => {
    const inventory: GitInventory = {
      errors: [],
      repositories: [
        {
          identity: {
            gitCommonDir: '/repos/widgets/.git',
            repositoryRoot: '/repos/widgets',
          },
          worktrees: [worktree('/repos/widgets', 'main', false, ['root-1'])],
        },
      ],
    };

    const projected = projectBranchesForTest(inventory);

    expect(projected.byRootId.get('root-1')).toEqual({
      branch: 'main',
      detached: false,
      gitCommonDir: '/repos/widgets/.git',
    });
  });
});
