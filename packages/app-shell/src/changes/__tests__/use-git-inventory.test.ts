import type { GitInventory, WorktreeDescriptor } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangesBridge } from '../changes-bridge';
import { useChangesLiveRefreshStore } from '../changes-live-refresh-store';
import { useGitInventory } from '../use-git-inventory';

function worktree(overrides: Partial<WorktreeDescriptor> = {}): WorktreeDescriptor {
  return {
    bare: false,
    branch: 'main',
    containment: ['root-1'],
    current: true,
    detached: false,
    head: 'abc123',
    lockedReason: null,
    name: 'repo',
    path: '/repo',
    provenance: 'scanned',
    prunableReason: null,
    trust: 'validated',
    trustReason: null,
    ...overrides,
  };
}

function inventoryFixture(overrides: Partial<GitInventory> = {}): GitInventory {
  return {
    errors: [],
    repositories: [
      {
        identity: { gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
        worktrees: [worktree()],
      },
    ],
    ...overrides,
  };
}

/**
 * Fills in every method this suite does not exercise — `resolveChangesBridge`
 * requires a FULLY formed bridge, so an omitted rewind method (BST-1115) reads
 * as malformed and the hook goes inert.
 */
function stubBridge(bridge: Partial<ChangesBridge>): void {
  (window as unknown as { changes?: Partial<ChangesBridge> }).changes = {
    applyRewind: vi.fn(),
    fileDiff: vi.fn(),
    finalizeRewinds: vi.fn(),
    onInvalidated: vi.fn(() => () => {}),
    redoRewind: vi.fn(),
    resolveView: vi.fn(),
    rewindPreview: vi.fn(),
    ...bridge,
  };
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as { changes?: unknown }, 'changes');
  useChangesLiveRefreshStore.getState().reset();
});

describe('useGitInventory', () => {
  it('is inert with the bridge absent', async () => {
    const { result } = renderHook(() => useGitInventory());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.available).toBe(false);
    expect(result.current.inventory).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('loads the inventory, preserving per-repository errors', async () => {
    const value = inventoryFixture({ errors: ['repo /tmp/broken: not a git repository'] });
    stubBridge({ inventory: vi.fn(async () => ({ ok: true, value }) as const) });

    const { result } = renderHook(() => useGitInventory());

    await waitFor(() => {
      expect(result.current.inventory).toEqual(value);
    });
    expect(result.current.available).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('distinguishes a resolved empty inventory from "not yet resolved"', async () => {
    const empty: GitInventory = { errors: [], repositories: [] };
    stubBridge({ inventory: vi.fn(async () => ({ ok: true, value: empty }) as const) });

    const { result } = renderHook(() => useGitInventory());

    await waitFor(() => {
      expect(result.current.inventory).not.toBeNull();
    });
    // A resolved-but-empty inventory is an honest "no repositories", NOT the
    // `null` sentinel the hook uses for "nothing loaded yet".
    expect(result.current.inventory).toEqual(empty);
    expect(result.current.error).toBeNull();
  });

  it('surfaces a typed bridge failure and clears the inventory', async () => {
    stubBridge({
      inventory: vi.fn(async () => ({ error: 'inventory-unavailable', ok: false }) as const),
    });

    const { result } = renderHook(() => useGitInventory());

    await waitFor(() => {
      expect(result.current.error).toBe('inventory-unavailable');
    });
    expect(result.current.inventory).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('surfaces a thrown bridge call as an error', async () => {
    stubBridge({
      inventory: vi.fn(async () => {
        throw new Error('ipc exploded');
      }),
    });

    const { result } = renderHook(() => useGitInventory());

    await waitFor(() => {
      expect(result.current.error).toBe('ipc exploded');
    });
    expect(result.current.inventory).toBeNull();
  });

  it('loads on mount by default, so the Changes surface keeps its eager inventory', async () => {
    const inventory = vi.fn(async () => ({ ok: true, value: inventoryFixture() }) as const);
    stubBridge({ inventory });

    renderHook(() => useGitInventory());

    await waitFor(() => {
      expect(inventory).toHaveBeenCalledTimes(1);
    });
  });

  it('skips the mount-time load with deferInitialLoad, then loads on the first refresh', async () => {
    // BST-1116 W6 review finding 4: the git panel header must not trigger a
    // full repo/worktree scan just by mounting. Deferral is OPT-IN so the
    // Changes surface (which needs the inventory eagerly) is untouched.
    const inventory = vi.fn(async () => ({ ok: true, value: inventoryFixture() }) as const);
    stubBridge({ inventory });

    const { result } = renderHook(() => useGitInventory({ deferInitialLoad: true }));

    await waitFor(() => {
      expect(result.current.available).toBe(true);
    });
    expect(inventory).not.toHaveBeenCalled();
    // The deferred pre-load state is distinguishable from "loading": no scan
    // is in flight, because none has been requested.
    expect(result.current.loading).toBe(false);
    expect(result.current.inventory).toBeNull();
    expect(result.current.error).toBeNull();

    await act(async () => {
      await result.current.refresh();
    });

    expect(inventory).toHaveBeenCalledTimes(1);
    expect(result.current.inventory).toEqual(inventoryFixture());
  });

  it('refetches on ANY accepted invalidation event (BST-1161) — inventory spans every repo', async () => {
    const inventory = vi.fn(async () => ({ ok: true, value: inventoryFixture() }) as const);
    stubBridge({ inventory });

    renderHook(() => useGitInventory());
    await waitFor(() => {
      expect(inventory).toHaveBeenCalledTimes(1);
    });

    act(() => {
      useChangesLiveRefreshStore.getState().ingestInvalidation({
        generation: 1,
        gitCommonDir: '/mystery/.git',
        repositoryRoot: null,
      });
    });
    await waitFor(() => {
      expect(inventory).toHaveBeenCalledTimes(2);
    });
  });

  it('a deferred instance that was never asked to load does not refetch on invalidation (BST-1161)', async () => {
    // The deferral exists so merely MOUNTING the git panel header does not
    // trigger a repo scan — a push event must not defeat that either. Once the
    // caller HAS requested a load, later invalidations keep it fresh.
    const inventory = vi.fn(async () => ({ ok: true, value: inventoryFixture() }) as const);
    stubBridge({ inventory });

    const { result } = renderHook(() => useGitInventory({ deferInitialLoad: true }));
    await waitFor(() => {
      expect(result.current.available).toBe(true);
    });

    act(() => {
      useChangesLiveRefreshStore.getState().ingestInvalidation({
        generation: 1,
        gitCommonDir: '/repo/.git',
        repositoryRoot: '/repo',
      });
    });
    expect(inventory).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.refresh();
    });
    expect(inventory).toHaveBeenCalledTimes(1);

    act(() => {
      useChangesLiveRefreshStore.getState().ingestInvalidation({
        generation: 2,
        gitCommonDir: '/repo/.git',
        repositoryRoot: '/repo',
      });
    });
    await waitFor(() => {
      expect(inventory).toHaveBeenCalledTimes(2);
    });
  });

  it('pauses invalidation scans while inactive and refreshes on reactivation', async () => {
    const inventory = vi.fn(async () => ({ ok: true, value: inventoryFixture() }) as const);
    stubBridge({ inventory });

    const { rerender, result } = renderHook(
      (active: boolean) => useGitInventory({ active, deferInitialLoad: !active }),
      { initialProps: false }
    );
    expect(inventory).not.toHaveBeenCalled();

    await act(async () => {
      rerender(true);
    });
    expect(inventory).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);

    act(() => {
      rerender(false);
    });
    act(() => {
      useChangesLiveRefreshStore.getState().ingestInvalidation({
        generation: 1,
        gitCommonDir: '/repo/.git',
        repositoryRoot: '/repo',
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(inventory).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender(true);
    });
    expect(inventory).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(false);
  });

  it('does not expose the previous activation inventory while reactivation refreshes', async () => {
    const stale = inventoryFixture({ errors: ['stale'] });
    const fresh = inventoryFixture({ errors: ['fresh'] });
    let call = 0;
    const freshGate: { release: (() => void) | null } = { release: null };
    const inventory = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return { ok: true, value: stale } as const;
      }
      await new Promise<void>((resolve) => {
        freshGate.release = resolve;
      });
      return { ok: true, value: fresh } as const;
    });
    stubBridge({ inventory });

    const { rerender, result } = renderHook(
      (active: boolean) => useGitInventory({ active, deferInitialLoad: !active }),
      { initialProps: true }
    );
    await waitFor(() => {
      expect(result.current.inventory).toEqual(stale);
    });

    act(() => {
      rerender(false);
    });
    expect(result.current.inventory).toBeNull();
    expect(result.current.error).toBeNull();

    act(() => {
      rerender(true);
    });
    await waitFor(() => {
      expect(inventory).toHaveBeenCalledTimes(2);
      expect(result.current.loading).toBe(true);
    });
    expect(result.current.inventory).toBeNull();

    freshGate.release?.();
    await waitFor(() => {
      expect(result.current.inventory).toEqual(fresh);
    });
  });

  it('ignores a stale in-flight load when a newer refresh supersedes it', async () => {
    const slow = inventoryFixture();
    const fresh = inventoryFixture({ errors: ['newer'] });
    let call = 0;
    const slowGate: { release: (() => void) | null } = { release: null };
    const inventory = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        await new Promise<void>((resolve) => {
          slowGate.release = resolve;
        });
        return { ok: true, value: slow } as const;
      }
      return { ok: true, value: fresh } as const;
    });
    stubBridge({ inventory });

    const { result } = renderHook(() => useGitInventory());
    await waitFor(() => {
      expect(inventory).toHaveBeenCalledTimes(1);
    });

    // Second load starts and settles while the first is still parked.
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.inventory).toEqual(fresh);

    // Releasing the stale first load must NOT overwrite the newer result.
    slowGate.release?.();
    await waitFor(() => {
      expect(inventory).toHaveBeenCalledTimes(2);
    });
    expect(result.current.inventory).toEqual(fresh);
  });
});
