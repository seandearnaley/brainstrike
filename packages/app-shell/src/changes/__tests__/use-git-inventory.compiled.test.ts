import type { GitInventory } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangesBridge } from '../changes-bridge';
import { useChangesLiveRefreshStore } from '../changes-live-refresh-store';
import { useGitInventory } from '../use-git-inventory';

afterEach(() => {
  Reflect.deleteProperty(window as unknown as { changes?: unknown }, 'changes');
  useChangesLiveRefreshStore.getState().reset();
});

describe('useGitInventory under the React Compiler', () => {
  it('does not expose the previous activation inventory while reactivation refreshes', async () => {
    const stale: GitInventory = { errors: ['stale'], repositories: [] };
    const fresh: GitInventory = { errors: ['fresh'], repositories: [] };
    const freshGate: { release: (() => void) | null } = { release: null };
    const inventory = vi.fn(async () => {
      if (inventory.mock.calls.length === 1) {
        return { ok: true, value: stale } as const;
      }
      await new Promise<void>((resolve) => {
        freshGate.release = resolve;
      });
      return { ok: true, value: fresh } as const;
    });
    // `resolveChangesBridge` requires a fully formed bridge.
    const bridge: ChangesBridge = {
      applyRewind: vi.fn(),
      fileDiff: vi.fn(),
      finalizeRewinds: vi.fn(),
      inventory,
      onInvalidated: vi.fn(() => () => {}),
      redoRewind: vi.fn(),
      resolveView: vi.fn(),
      rewindPreview: vi.fn(),
    };
    (window as unknown as { changes?: ChangesBridge }).changes = bridge;

    const { rerender, result } = renderHook(
      (active: boolean) => useGitInventory({ active, deferInitialLoad: !active }),
      { initialProps: true }
    );
    await waitFor(() => expect(result.current.inventory).toEqual(stale));

    act(() => rerender(false));
    expect(result.current.inventory).toBeNull();

    act(() => rerender(true));
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.inventory).toBeNull();

    freshGate.release?.();
    await waitFor(() => expect(result.current.inventory).toEqual(fresh));
  });
});
