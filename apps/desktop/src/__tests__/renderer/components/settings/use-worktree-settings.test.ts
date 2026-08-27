import { resolveWorktreesBridge } from '@brainstrike/app-shell/worktrees/availability';
import type { WorktreeSettings } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWorktreeSettings } from '../../../../renderer/components/settings/use-worktree-settings';

vi.mock('@brainstrike/app-shell/worktrees/availability', () => ({
  resolveWorktreesBridge: vi.fn(),
}));

type WorktreesBridge = NonNullable<ReturnType<typeof resolveWorktreesBridge>>;

const SETTINGS: WorktreeSettings = {
  isDefaultDirectory: true,
  managedDirectory: '/home/me/.brainstrike/worktrees',
  setupCommand: null,
};

function createBridge({
  getSettings,
  setSettings,
}: Pick<WorktreesBridge, 'getSettings' | 'setSettings'>): WorktreesBridge {
  return { getSettings, setSettings } as WorktreesBridge;
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('useWorktreeSettings', () => {
  it('reports a getSettings result error', async () => {
    vi.mocked(resolveWorktreesBridge).mockReturnValue(
      createBridge({
        getSettings: vi.fn(async () => ({
          error: 'settings could not be read',
          ok: false as const,
        })),
        setSettings: vi.fn(async () => ({ ok: true as const, value: SETTINGS })),
      })
    );

    const { result } = renderHook(() => useWorktreeSettings());

    await waitFor(() => {
      expect(result.current.status).toEqual({
        kind: 'error',
        message: 'settings could not be read',
      });
    });
  });

  it('reports a rejected getSettings promise', async () => {
    vi.mocked(resolveWorktreesBridge).mockReturnValue(
      createBridge({
        getSettings: vi.fn(() => Promise.reject(new Error('settings bridge rejected'))),
        setSettings: vi.fn(async () => ({ ok: true as const, value: SETTINGS })),
      })
    );

    const { result } = renderHook(() => useWorktreeSettings());

    await waitFor(() => {
      expect(result.current.status).toEqual({
        kind: 'error',
        message: 'settings bridge rejected',
      });
    });
  });

  it('rejects save with the setSettings result error', async () => {
    vi.mocked(resolveWorktreesBridge).mockReturnValue(
      createBridge({
        getSettings: vi.fn(async () => ({ ok: true as const, value: SETTINGS })),
        setSettings: vi.fn(async () => ({
          error: 'settings could not be saved',
          ok: false as const,
        })),
      })
    );
    const { result } = renderHook(() => useWorktreeSettings());
    await waitFor(() => {
      expect(result.current.status).toEqual({ kind: 'ready' });
    });

    await expect(
      result.current.save({ managedDirectory: '/worktrees', setupCommand: null })
    ).rejects.toThrow('settings could not be saved');
  });

  it('updates settings after a successful save', async () => {
    const updatedSettings: WorktreeSettings = {
      isDefaultDirectory: false,
      managedDirectory: '/worktrees',
      setupCommand: ['pnpm', 'install'],
    };
    const setSettings = vi.fn(async () => ({ ok: true as const, value: updatedSettings }));
    vi.mocked(resolveWorktreesBridge).mockReturnValue(
      createBridge({
        getSettings: vi.fn(async () => ({ ok: true as const, value: SETTINGS })),
        setSettings,
      })
    );
    const { result } = renderHook(() => useWorktreeSettings());
    await waitFor(() => {
      expect(result.current.status).toEqual({ kind: 'ready' });
    });
    const next = {
      managedDirectory: '/worktrees',
      setupCommand: ['pnpm', 'install'],
    } as const;

    await act(async () => {
      await result.current.save(next);
    });

    expect(setSettings).toHaveBeenCalledWith(next);
    expect(result.current.settings).toEqual(updatedSettings);
  });

  it('reports an unavailable bridge on the first render', () => {
    vi.mocked(resolveWorktreesBridge).mockReturnValue(null);

    const { result } = renderHook(() => useWorktreeSettings());

    expect(result.current.status).toEqual({ kind: 'unavailable' });
  });
});
