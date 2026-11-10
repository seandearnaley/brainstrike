/**
 * The worktree listing behind the Threads panel's folder grouping, against a
 * stubbed worktrees bridge: one read for the whole panel, only while folder
 * grouping shows, and a failure that is reported rather than read as "no
 * repositories".
 */
import type { WorktreeListEntry } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useChangesLiveRefreshStore } from '../changes/changes-live-refresh-store';
import { useThreadRepositoryListing } from '../hooks/use-thread-repository-listing';
import { stubWorktreesBridge, workspaceGitWrapper } from './helpers/workspace-git-services-wrapper';

const OWN_CHECKOUT: WorktreeListEntry = {
  branch: 'main',
  containment: ['root-repo'],
  createdAt: null,
  detached: false,
  disabledReason: null,
  externalTool: null,
  id: null,
  lockedReason: null,
  managed: false,
  name: 'brainstrike',
  path: '/code/brainstrike',
  primary: true,
  provenance: 'scanned',
  remedy: null,
  repoCommonDir: '/code/brainstrike/.git',
  repositoryRoot: '/code/brainstrike',
  rootId: 'root-repo',
  rootIdIsExactMount: true,
  setupReason: null,
  setupStatus: 'none',
  trust: 'validated',
  trustReason: null,
  usable: true,
};

function listing(entries: readonly WorktreeListEntry[] = [OWN_CHECKOUT]) {
  return vi.fn(async () => ({ ok: true, value: entries }) as const);
}

afterEach(() => {
  useChangesLiveRefreshStore.getState().reset();
});

describe('useThreadRepositoryListing', () => {
  it('reads nothing while another grouping shows', async () => {
    const list = listing();

    const { result } = renderHook(() => useThreadRepositoryListing({ enabled: false }), {
      wrapper: workspaceGitWrapper({ worktrees: stubWorktreesBridge({ list }) }),
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(list).not.toHaveBeenCalled();
    expect(result.current.entries).toBeNull();
  });

  it('does not redraw its panel for a git change while another grouping shows', async () => {
    let renders = 0;
    const { result } = renderHook(
      () => {
        renders += 1;
        return useThreadRepositoryListing({ enabled: false });
      },
      { wrapper: workspaceGitWrapper({ worktrees: stubWorktreesBridge({ list: listing() }) }) }
    );
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    const before = renders;

    act(() => {
      useChangesLiveRefreshStore.getState().ingestInvalidation({
        generation: 1,
        gitCommonDir: '/code/brainstrike/.git',
        repositoryRoot: '/code/brainstrike',
      });
    });

    // A commit, a branch switch or a new worktree is none of Date's business.
    expect(renders).toBe(before);
  });

  it('reads the listing once for the panel, then again when git reports a change', async () => {
    const list = listing();

    const { result } = renderHook(() => useThreadRepositoryListing({ enabled: true }), {
      wrapper: workspaceGitWrapper({ worktrees: stubWorktreesBridge({ list }) }),
    });

    expect(result.current.loading).toBe(true);
    await waitFor(() => {
      expect(result.current.entries).toEqual([OWN_CHECKOUT]);
    });
    expect(result.current.loading).toBe(false);
    expect(list).toHaveBeenCalledTimes(1);

    act(() => {
      useChangesLiveRefreshStore.getState().ingestInvalidation({
        generation: 1,
        gitCommonDir: '/code/brainstrike/.git',
        repositoryRoot: '/code/brainstrike',
      });
    });

    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(2);
    });
    // The rows already on screen stay while the re-read is in flight.
    expect(result.current.entries).toEqual([OWN_CHECKOUT]);
    expect(result.current.loading).toBe(false);
  });

  it('reports a failed listing instead of an empty one', async () => {
    const list = vi.fn(
      async () =>
        ({
          error: {
            category: 'internal',
            code: 'git.command-failed',
            kind: 'fault',
            message: 'git worktree list failed',
          },
          ok: false,
        }) as const
    );

    const { result } = renderHook(() => useThreadRepositoryListing({ enabled: true }), {
      wrapper: workspaceGitWrapper({ worktrees: stubWorktreesBridge({ list }) }),
    });

    await waitFor(() => {
      expect(result.current.error).toContain('git worktree list failed');
    });
    expect(result.current.entries).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('is settled with no listing where the host serves no worktrees', () => {
    const { result } = renderHook(() => useThreadRepositoryListing({ enabled: true }), {
      wrapper: workspaceGitWrapper({}),
    });

    expect(result.current).toEqual({ entries: null, error: null, loading: false });
  });
});
