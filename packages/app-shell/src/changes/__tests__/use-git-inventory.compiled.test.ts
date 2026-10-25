import { act } from '@brainstrike/test-utils/react-act';
import type { GitInventory } from '@brainstrike/types';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  stubChangesBridge,
  workspaceGitWrapper,
} from '../../__tests__/helpers/workspace-git-services-wrapper';
import { useChangesLiveRefreshStore } from '../changes-live-refresh-store';
import { useGitInventory } from '../use-git-inventory';

afterEach(() => {
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
    const wrapper = workspaceGitWrapper({ changes: stubChangesBridge({ inventory }) });

    const { rerender, result } = renderHook(
      (active: boolean) => useGitInventory({ active, deferInitialLoad: !active }),
      { initialProps: true, wrapper }
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
