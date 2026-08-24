import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import type { GitRepository, GitStatus } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChangesNavigationStore } from '../changes/changes-navigation-store';
import type { GitBridge } from '../git-panel/git-bridge';
import { useWorkspaceBranchMenu } from '../workspace-bar/use-workspace-branch-menu';

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  toast,
}));

const status = (clean: boolean): GitStatus => ({
  ahead: 0,
  behind: 0,
  branch: 'main',
  clean,
  files: [],
  isRepository: true,
  upstream: null,
});

const repository: GitRepository = {
  branches: [
    { current: true, head: 'a'.repeat(40), name: 'main', upstream: null, worktreePath: null },
    { current: false, head: 'b'.repeat(40), name: 'recent', upstream: null, worktreePath: null },
    {
      current: false,
      head: 'c'.repeat(40),
      name: 'held',
      upstream: null,
      worktreePath: '/tmp/held-copy',
    },
  ],
  currentWorktree: {
    bare: false,
    branch: 'main',
    current: true,
    detached: false,
    head: 'a'.repeat(40),
    lockedReason: null,
    name: 'repo',
    path: '/repo',
    prunableReason: null,
  },
  defaultRemote: 'origin',
  name: 'repo',
  openedRoot: '/repo',
  remotes: ['origin'],
  repositoryRoot: '/repo',
  scope: 'repository',
  worktrees: [],
};

function bridge(clean = true): GitBridge {
  const okNull = vi.fn(async () => ({ ok: true as const, value: null }));
  return {
    aheadBehind: vi.fn(),
    commit: vi.fn(),
    commitFiles: vi.fn(),
    createBranch: vi.fn(async (_rootId, params) => ({
      ok: true as const,
      value: { branch: params.branch },
    })),
    diff: vi.fn(),
    fetch: vi.fn(async () => ({ ok: true as const, value: { output: 'fetched' } })),
    history: vi.fn(),
    pull: vi.fn(),
    push: vi.fn(),
    repository: vi.fn(async () => ({ ok: true as const, value: repository })),
    stage: okNull,
    status: vi.fn(async () => ({ ok: true as const, value: status(clean) })),
    structuredFileDiff: vi.fn(),
    switchBranch: vi.fn(async (_rootId, params) => ({
      ok: true as const,
      value: { branch: params.branch },
    })),
    unstage: okNull,
  };
}

beforeEach(() => {
  toast.mockReset();
  useChangesNavigationStore.getState().reset();
  usePanelLayoutStore.setState({ activeTab: 'git' });
});

describe('useWorkspaceBranchMenu', () => {
  it('loads the shared row model and switches only after a fresh clean-status check', async () => {
    const git = bridge();
    const onBranchChanged = vi.fn();
    const { result } = renderHook(() =>
      useWorkspaceBranchMenu({
        bridge: git,
        checkout: { ahead: 0, behind: 0, branch: 'main', dirty: false },
        onBranchChanged,
        root: { path: '/repo', rootId: 'root-1' },
      })
    );

    act(() => result.current?.onOpenChange(true));
    await waitFor(() =>
      expect(result.current?.rows.map((row) => row.name)).toEqual(['main', 'recent', 'held'])
    );
    expect(result.current?.rows.find((row) => row.name === 'held')?.worktreeName).toBe('held-copy');

    await act(async () => {
      await result.current?.onSwitchBranch('recent');
    });
    expect(git.status).toHaveBeenCalledWith('root-1');
    expect(git.switchBranch).toHaveBeenCalledWith('root-1', { branch: 'recent' });
    expect(onBranchChanged).toHaveBeenCalledWith('recent');
  });

  it('refuses a stale dirty checkout before invoking switch and explains the unavailable worktree path', async () => {
    const git = bridge(false);
    const { result } = renderHook(() =>
      useWorkspaceBranchMenu({
        bridge: git,
        checkout: { ahead: 0, behind: 0, branch: 'main', dirty: false },
        onBranchChanged: vi.fn(),
        root: { path: '/repo', rootId: 'root-1' },
      })
    );
    act(() => result.current?.onOpenChange(true));
    await waitFor(() => expect(result.current?.rows).toHaveLength(3));

    await act(async () => {
      await result.current?.onSwitchBranch('recent');
    });
    expect(git.switchBranch).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('new worktree is unavailable'),
        variant: 'destructive',
      })
    );
  });

  it('creates, fetches, and opens the current checkout in Changes', async () => {
    const git = bridge();
    const { result } = renderHook(() =>
      useWorkspaceBranchMenu({
        bridge: git,
        checkout: { ahead: 0, behind: 0, branch: 'main', dirty: false },
        onBranchChanged: vi.fn(),
        root: { path: '/repo', rootId: 'root-1' },
      })
    );
    act(() => result.current?.onOpenChange(true));
    await waitFor(() => expect(result.current?.rows).toHaveLength(3));

    await act(async () => {
      await result.current?.onCreateBranch('feature/new');
      await result.current?.onFetch('origin');
    });
    expect(git.createBranch).toHaveBeenCalledWith('root-1', { branch: 'feature/new' });
    expect(git.fetch).toHaveBeenCalledWith('root-1', { remote: 'origin' });

    act(() => result.current?.onOpenChanges());
    expect(useChangesNavigationStore.getState().activeChangeset).toEqual({
      kind: 'git-scope',
      repositoryRoot: '/repo',
      scope: { kind: 'uncommitted' },
      worktreePath: '/repo',
    });
    expect(usePanelLayoutStore.getState().activeTab).toBe('explorer');
  });

  it('surfaces create, fetch, and premature Changes failures', async () => {
    const git = bridge();
    vi.mocked(git.createBranch).mockResolvedValue({ error: 'create denied', ok: false });
    vi.mocked(git.fetch).mockResolvedValue({ error: 'offline', ok: false });
    const { result } = renderHook(() =>
      useWorkspaceBranchMenu({
        bridge: git,
        checkout: { ahead: 0, behind: 0, branch: 'main', dirty: false },
        onBranchChanged: vi.fn(),
        root: { path: '/repo', rootId: 'root-1' },
      })
    );

    act(() => result.current?.onOpenChanges());
    await act(async () => {
      await result.current?.onCreateBranch('feature/denied');
      await result.current?.onFetch('origin');
    });

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Repository details have not loaded yet.' })
    );
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: 'create denied' }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: 'offline' }));
  });
});
