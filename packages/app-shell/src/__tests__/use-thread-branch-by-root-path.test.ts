import type { GitInventory } from '@brainstrike/types';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useGitInventoryMock } = vi.hoisted(() => ({ useGitInventoryMock: vi.fn() }));
vi.mock('../changes/use-git-inventory', () => ({ useGitInventory: useGitInventoryMock }));

import { useThreadBranchByRootPath } from '../hooks/use-thread-branch-by-root-path';

function worktree(
  path: string,
  branch: string | null,
  detached: boolean
): GitInventory['repositories'][number]['worktrees'][number] {
  return {
    bare: false,
    branch,
    containment: ['root-a'],
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

    const { result } = renderHook(() => useThreadBranchByRootPath());

    expect(result.current.available).toBe(true);
    expect(result.current.byRootPath.get('/work/a')).toEqual({ branch: 'main', detached: false });
    expect(result.current.byRootPath.get('/work/a-wt')).toEqual({ branch: null, detached: true });
    expect(result.current.byRootPath.size).toBe(2);
  });

  it('loads the inventory eagerly — this projection is not behind a gesture', () => {
    mockInventory(INVENTORY);

    renderHook(() => useThreadBranchByRootPath());

    expect(useGitInventoryMock).toHaveBeenCalledTimes(1);
    expect(useGitInventoryMock.mock.calls[0]?.[0]).toBeUndefined();
  });

  it('reports unavailable with an empty map on web, where there is no bridge', () => {
    mockInventory(null, false);

    const { result } = renderHook(() => useThreadBranchByRootPath());

    expect(result.current.available).toBe(false);
    expect(result.current.byRootPath.size).toBe(0);
  });

  it('reports an empty map while the inventory is still unresolved', () => {
    mockInventory(null);

    const { result } = renderHook(() => useThreadBranchByRootPath());

    expect(result.current.available).toBe(true);
    expect(result.current.byRootPath.size).toBe(0);
  });

  it('memoizes the map on inventory identity', () => {
    mockInventory(INVENTORY);
    const { rerender, result } = renderHook(() => useThreadBranchByRootPath());
    const first = result.current.byRootPath;

    rerender();

    expect(result.current.byRootPath).toBe(first);
  });

  // Exact-path matching only: a root that merely CONTAINS worktrees has no
  // branch of its own and must not borrow one.
  it('yields nothing for a workspace root that only contains worktrees', () => {
    mockInventory(INVENTORY);

    const { result } = renderHook(() => useThreadBranchByRootPath());

    expect(result.current.byRootPath.has('/work')).toBe(false);
    expect(result.current.byRootPath.has('root-a')).toBe(false);
  });
});
