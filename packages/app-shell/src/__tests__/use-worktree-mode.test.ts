import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addRootByPathSpy,
  addRootDirectorySpy,
  archiveSpy,
  createSpy,
  getSettingsSpy,
  listSpy,
  toastSpy,
} = vi.hoisted(() => ({
  addRootByPathSpy: vi.fn(),
  addRootDirectorySpy: vi.fn(),
  archiveSpy: vi.fn(),
  createSpy: vi.fn(),
  getSettingsSpy: vi.fn(),
  listSpy: vi.fn(),
  toastSpy: vi.fn(),
}));

vi.mock('../worktrees/worktrees-bridge', () => ({
  resolveWorktreesBridge: () => ({
    archive: archiveSpy,
    create: createSpy,
    createBranchHere: vi.fn(),
    getSettings: getSettingsSpy,
    list: listSpy,
    listManagedPaths: vi.fn(),
    restore: vi.fn(),
    setSettings: vi.fn(),
  }),
}));
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileSystem: () => ({
    addRootDirectory: addRootDirectorySpy,
    addRootDirectoryByPath: addRootByPathSpy,
  }),
}));
vi.mock('@brainstrike/ui', () => ({ toast: toastSpy }));

import { useWorktreeMode } from '../hooks/use-worktree-mode';

const onHandOffToLocal = vi.fn(() => Promise.resolve());
const onSelectWorktree = vi.fn(() => Promise.resolve());

const ARGS = {
  checkout: { mode: 'local' as const, worktreeId: null },
  hasSentFirstRequest: false,
  isRepository: true,
  onHandOffToLocal,
  onSelectWorktree,
  primaryRootId: 'r-1',
  primaryRootPath: '/work/app',
  runId: null,
};

const CREATE_REQUEST = {
  baseRef: 'main',
  branch: { name: 'bs/bright-fox' },
  name: 'bright-fox',
} as const;

describe('useWorktreeMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingsSpy.mockResolvedValue({
      ok: true,
      value: {
        isDefaultDirectory: true,
        managedDirectory: '/home/me/.brainstrike/worktrees',
        setupCommand: null,
      },
    });
    listSpy.mockResolvedValue({ ok: true, value: [] });
    createSpy.mockResolvedValue({
      ok: true,
      value: {
        setup: {
          copiedPaths: [],
          output: '',
          reason: null,
          skippedCopies: [],
          status: 'none',
          truncated: false,
        },
        worktree: {
          archivedAt: null,
          archiveSnapshotRef: null,
          baseRef: 'main',
          branch: 'bs/bright-fox',
          createdAt: '2026-08-24T00:00:00.000Z',
          createdBy: 'user',
          id: 'w-1',
          path: '/managed/app/bright-fox',
          repoCommonDir: '/work/app/.git',
          runId: null,
          setupOutput: null,
          setupReason: null,
          setupStatus: 'none',
          threadId: 't-1',
        },
      },
    });
    addRootByPathSpy.mockResolvedValue({
      name: 'bright-fox',
      path: '/managed/app/bright-fox',
    });
    addRootDirectorySpy.mockResolvedValue({ name: 'picked', path: '/picked' });
  });

  it('is undefined without a primary root', async () => {
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, primaryRootId: null }));
    expect(result.current).toBeUndefined();
    await act(async () => {});
  });

  it('is disabled with the stated reason for a non-repository folder', async () => {
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, isRepository: false }));
    expect(result.current?.disabledReason).toBe('Not a git repository');
    await act(async () => {});
  });

  it('disables creation after the first request while leaving handoff available', async () => {
    const { result, rerender } = renderHook(
      ({ hasSentFirstRequest }) =>
        useWorktreeMode({
          ...ARGS,
          checkout: { mode: 'worktree', worktreeId: 'w-1' },
          hasSentFirstRequest,
        }),
      { initialProps: { hasSentFirstRequest: false } }
    );
    await waitFor(() => expect(result.current?.createDisabledReason).toBeNull());

    rerender({ hasSentFirstRequest: true });

    expect(result.current?.createDisabledReason).toContain('first request');
    expect(result.current?.onHandOffToLocal).toBeDefined();
  });

  it('mounts the created worktree as a root and then binds the thread to it', async () => {
    const { result } = renderHook(() => useWorktreeMode(ARGS));
    await waitFor(() => expect(result.current?.createDisabledReason).toBeNull());
    await act(async () => {
      await result.current?.onCreate(CREATE_REQUEST);
    });
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: 'user', name: 'bright-fox', rootId: 'r-1' })
    );
    expect(addRootByPathSpy).toHaveBeenCalledWith('/managed/app/bright-fox');
    expect(onSelectWorktree).toHaveBeenCalledWith({
      branch: 'bs/bright-fox',
      path: '/managed/app/bright-fox',
      worktreeId: 'w-1',
    });
    expect(addRootByPathSpy.mock.invocationCallOrder[0]).toBeLessThan(
      onSelectWorktree.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it('rejects and toasts a service failure so the sheet can show it', async () => {
    createSpy.mockResolvedValue({
      error: 'local branch "bs/bright-fox" already exists',
      ok: false,
    });
    const { result } = renderHook(() => useWorktreeMode(ARGS));
    await waitFor(() => expect(result.current?.createDisabledReason).toBeNull());

    await act(async () => {
      await expect(result.current?.onCreate(CREATE_REQUEST)).rejects.toThrow(
        'local branch "bs/bright-fox" already exists'
      );
    });

    expect(toastSpy).toHaveBeenCalledWith({
      description: 'local branch "bs/bright-fox" already exists',
      title: 'Worktree creation failed',
      variant: 'destructive',
    });
    expect(onSelectWorktree).not.toHaveBeenCalled();
  });

  it('rejects and toasts when the created worktree cannot be mounted', async () => {
    addRootByPathSpy.mockResolvedValue(undefined);
    const { result } = renderHook(() => useWorktreeMode(ARGS));
    await waitFor(() => expect(result.current?.createDisabledReason).toBeNull());

    await act(async () => {
      await expect(result.current?.onCreate(CREATE_REQUEST)).rejects.toThrow(
        'could not be mounted as a workspace folder'
      );
    });

    expect(toastSpy).toHaveBeenCalledWith({
      description: expect.stringContaining('could not be mounted as a workspace folder'),
      title: 'Worktree mount failed',
      variant: 'destructive',
    });
    expect(onSelectWorktree).not.toHaveBeenCalled();
  });

  it('forwards the active runId so the operation lands in the timeline', async () => {
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, runId: 'run-9' }));
    await waitFor(() => expect(result.current?.createDisabledReason).toBeNull());
    await act(async () => {
      await result.current?.onCreate({
        baseRef: 'main',
        branch: { detached: true },
        name: 'x',
      });
    });
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-9' }));
  });

  it('builds picker options from list(), preserving every disabled reason', async () => {
    listSpy.mockResolvedValue({
      ok: true,
      value: [
        {
          branch: null,
          containment: 'outside-roots',
          detached: true,
          disabledReason:
            "This worktree isn't inside any workspace folder yet — grant access to use it here.",
          externalTool: 'codex',
          id: null,
          lockedReason: null,
          managed: false,
          name: 'codex-one',
          path: '/Users/me/.codex/worktrees/codex-one',
          provenance: 'scanned',
          remedy: 'grant-access',
          repositoryRoot: '/work/app',
          rootId: null,
          setupReason: null,
          setupStatus: 'none',
          trust: 'validated',
          trustReason: null,
          usable: false,
        },
      ],
    });
    const { result } = renderHook(() => useWorktreeMode(ARGS));
    act(() => {
      result.current?.onOpenPicker();
    });
    await waitFor(() => expect(result.current?.picker.options).toHaveLength(1));
    expect(result.current?.picker.options[0]).toMatchObject({
      disabledReason: expect.stringContaining('grant access'),
      externalTool: 'codex',
      remedy: 'grant-access',
      usable: false,
    });
  });

  it('uses persisted setup status and reason for the selected worktree summary', async () => {
    listSpy.mockResolvedValue({
      ok: true,
      value: [
        {
          branch: 'bs/bright-fox',
          containment: ['r-1'],
          detached: false,
          disabledReason: null,
          externalTool: null,
          id: 'w-1',
          lockedReason: null,
          managed: true,
          name: 'bright-fox',
          path: '/managed/app/bright-fox',
          provenance: 'both',
          remedy: null,
          repositoryRoot: '/work/app',
          rootId: 'r-1',
          setupReason: 'Setup command exited with code 3.',
          setupStatus: 'failed',
          trust: 'validated',
          trustReason: null,
          usable: true,
        },
      ],
    });
    const { result } = renderHook(() =>
      useWorktreeMode({ ...ARGS, checkout: { mode: 'worktree', worktreeId: 'w-1' } })
    );
    act(() => {
      result.current?.onOpenPicker();
    });
    await waitFor(() =>
      expect(result.current?.worktree).toMatchObject({
        setupReason: 'Setup command exited with code 3.',
        setupStatus: 'failed',
      })
    );
  });

  it('routes Grant access through the OS picker, never a caller-supplied path', async () => {
    const { result } = renderHook(() => useWorktreeMode(ARGS));
    await waitFor(() => expect(result.current).toBeDefined());
    await act(async () => {
      result.current?.picker.onGrantAccess?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(addRootDirectorySpy).toHaveBeenCalledWith();
    expect(addRootByPathSpy).not.toHaveBeenCalled();
  });

  it('surfaces a list failure on the picker instead of an empty list', async () => {
    listSpy.mockResolvedValue({ error: 'inventory unavailable', ok: false });
    const { result } = renderHook(() => useWorktreeMode(ARGS));
    act(() => {
      result.current?.onOpenPicker();
    });
    await waitFor(() => expect(result.current?.picker.error).toBe('inventory unavailable'));
    expect(result.current?.picker.options).toEqual([]);
  });
});
