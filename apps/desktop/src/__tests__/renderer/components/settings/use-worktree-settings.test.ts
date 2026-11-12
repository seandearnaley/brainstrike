// @vitest-environment jsdom

import {
  NO_WORKSPACE_GIT_SERVICES,
  WorkspaceGitServicesProvider,
} from '@brainstrike/app-shell/workspace-git-services';
import type { WorktreesBridge } from '@brainstrike/app-shell/worktrees/availability';
import { refusal } from '@brainstrike/assistant-contract/boundary-failure';
import { act } from '@brainstrike/test-utils/react-act';
import type { WorktreeSettings } from '@brainstrike/types';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWorktreeSettings } from '../../../../renderer/components/settings/use-worktree-settings';

const SETTINGS: WorktreeSettings = {
  isDefaultDirectory: true,
  managedDirectory: '/home/me/.brainstrike/worktrees',
  setupCommand: null,
};

function createBridge({
  getSettings,
  setSettings,
}: Pick<WorktreesBridge, 'getSettings' | 'setSettings'>): WorktreesBridge {
  const unused = vi.fn();
  return {
    adopt: unused,
    archive: unused,
    checkoutStatus: unused,
    create: unused,
    createBranchHere: unused,
    createContext: unused,
    getSettings,
    inspectArchive: unused,
    list: unused,
    listArchived: unused,
    listManagedPaths: unused,
    restore: unused,
    setSettings,
  };
}

/** Renders the hook under a host serving `worktrees`, or none (web). */
function renderWorktreeSettings(worktrees: WorktreesBridge | null) {
  const services = { ...NO_WORKSPACE_GIT_SERVICES, worktrees };
  return renderHook(() => useWorktreeSettings(), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(WorkspaceGitServicesProvider, { children, services }),
  });
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('useWorktreeSettings', () => {
  it('reports a getSettings result error', async () => {
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({
        error: refusal({
          category: 'conflict',
          code: 'worktree.settings',
          message: 'settings could not be read',
        }),
        ok: false as const,
      })),
      setSettings: vi.fn(async () => ({ ok: true as const, value: SETTINGS })),
    });

    const { result } = renderWorktreeSettings(bridge);

    await waitFor(() => {
      expect(result.current.status).toEqual({
        kind: 'error',
        message: 'settings could not be read',
      });
    });
  });

  it('reports a rejected getSettings promise', async () => {
    const bridge = createBridge({
      getSettings: vi.fn(() => Promise.reject(new Error('settings bridge rejected'))),
      setSettings: vi.fn(async () => ({ ok: true as const, value: SETTINGS })),
    });

    const { result } = renderWorktreeSettings(bridge);

    await waitFor(() => {
      expect(result.current.status).toEqual({
        kind: 'error',
        message: 'settings bridge rejected',
      });
    });
  });

  it('rejects save with the setSettings result error', async () => {
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({ ok: true as const, value: SETTINGS })),
      setSettings: vi.fn(async () => ({
        error: refusal({
          category: 'conflict',
          code: 'worktree.settings',
          message: 'settings could not be saved',
        }),
        ok: false as const,
      })),
    });
    const { result } = renderWorktreeSettings(bridge);
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
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({ ok: true as const, value: SETTINGS })),
      setSettings,
    });
    const { result } = renderWorktreeSettings(bridge);
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
    const { result } = renderWorktreeSettings(null);

    expect(result.current.status).toEqual({ kind: 'unavailable' });
  });
});
