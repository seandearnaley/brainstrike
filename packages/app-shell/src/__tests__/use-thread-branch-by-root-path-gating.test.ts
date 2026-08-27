/**
 * The `enabled` gate against the REAL `useGitInventory` and a real stubbed
 * `window.changes` bridge — the sibling suite mocks the inventory hook, so it
 * can only assert the option passed, never that no scan happened.
 *
 * What is being protected (BST-1116 W6 review finding 4): `bridge.inventory()`
 * is a full repository/worktree scan across every workspace root. Branch chips
 * exist only in the Threads panel's folders grouping, so an ungated hook makes
 * every panel mount in EVERY grouping mode pay for that scan.
 */
import type { GitInventory } from '@brainstrike/types';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangesBridge } from '../changes/changes-bridge';
import { useChangesLiveRefreshStore } from '../changes/changes-live-refresh-store';
import { useThreadBranchByRootPath } from '../hooks/use-thread-branch-by-root-path';

const INVENTORY: GitInventory = {
  errors: [],
  repositories: [
    {
      identity: { gitCommonDir: '/work/a/.git', repositoryRoot: '/work/a' },
      worktrees: [
        {
          bare: false,
          branch: 'main',
          containment: ['root-a'],
          current: true,
          detached: false,
          head: 'abc1234',
          lockedReason: null,
          name: 'a',
          path: '/work/a',
          provenance: 'scanned',
          prunableReason: null,
          trust: 'validated',
          trustReason: null,
        },
      ],
    },
  ],
};

/**
 * `resolveChangesBridge` requires a FULLY formed bridge — an omitted method
 * reads as malformed and the hook goes inert, which would make the assertions
 * below pass for the wrong reason.
 */
function stubBridge(inventory: () => Promise<{ ok: true; value: GitInventory }>): void {
  (window as unknown as { changes?: Partial<ChangesBridge> }).changes = {
    applyRewind: vi.fn(),
    fileDiff: vi.fn(),
    finalizeRewinds: vi.fn(),
    inventory,
    onInvalidated: vi.fn(() => () => {}),
    redoRewind: vi.fn(),
    resolveView: vi.fn(),
    rewindPreview: vi.fn(),
  };
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as { changes?: unknown }, 'changes');
  useChangesLiveRefreshStore.getState().reset();
});

describe('useThreadBranchByRootPath gating', () => {
  it('runs no git scan while disabled, and still reports availability honestly', async () => {
    const inventory = vi.fn(async () => ({ ok: true, value: INVENTORY }) as const);
    stubBridge(inventory);

    const { result } = renderHook(() => useThreadBranchByRootPath({ enabled: false }));

    await waitFor(() => {
      expect(result.current.available).toBe(true);
    });
    expect(inventory).not.toHaveBeenCalled();
    expect(result.current.byRootPath.size).toBe(0);
  });

  it('scans exactly once when the gate flips true', async () => {
    const inventory = vi.fn(async () => ({ ok: true, value: INVENTORY }) as const);
    stubBridge(inventory);

    const { rerender, result } = renderHook(
      (enabled: boolean) => useThreadBranchByRootPath({ enabled }),
      { initialProps: false }
    );
    await waitFor(() => {
      expect(result.current.available).toBe(true);
    });
    expect(inventory).not.toHaveBeenCalled();

    rerender(true);

    await waitFor(() => {
      expect(result.current.byRootPath.get('/work/a')).toEqual({
        branch: 'main',
        detached: false,
        gitCommonDir: '/work/a/.git',
      });
    });
    expect(inventory).toHaveBeenCalledTimes(1);
  });
});
