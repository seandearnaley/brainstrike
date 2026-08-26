import type { WorktreeListEntry } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addRootByPathSpy,
  addRootDirectorySpy,
  archiveSpy,
  createBranchHereSpy,
  createContextSpy,
  createSpy,
  getSettingsSpy,
  listSpy,
  loggerErrorSpy,
  toastSpy,
} = vi.hoisted(() => ({
  addRootByPathSpy: vi.fn(),
  addRootDirectorySpy: vi.fn(),
  archiveSpy: vi.fn(),
  createBranchHereSpy: vi.fn(),
  createContextSpy: vi.fn(),
  createSpy: vi.fn(),
  getSettingsSpy: vi.fn(),
  listSpy: vi.fn(),
  loggerErrorSpy: vi.fn(),
  toastSpy: vi.fn(),
}));

vi.mock('../worktrees/worktrees-bridge', () => ({
  resolveWorktreesBridge: () => ({
    archive: archiveSpy,
    create: createSpy,
    createBranchHere: createBranchHereSpy,
    createContext: createContextSpy,
    getSettings: getSettingsSpy,
    list: listSpy,
    listManagedPaths: vi.fn(),
    restore: vi.fn(),
    setSettings: vi.fn(),
  }),
}));
vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => ({
    debug: vi.fn(),
    error: loggerErrorSpy,
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
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
    createBranchHereSpy.mockResolvedValue({ ok: true, value: null });
    createContextSpy.mockResolvedValue({
      ok: true,
      value: { managedParentPath: '/managed/app-slug', suggestedName: 'bright-fox' },
    });
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
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(onSelectWorktree).not.toHaveBeenCalled();
  });

  it('rejects and toasts exactly once when binding fails after creation', async () => {
    onSelectWorktree.mockRejectedValueOnce(new Error('bind boom'));
    const { result } = renderHook(() => useWorktreeMode(ARGS));
    await waitFor(() => expect(result.current?.createDisabledReason).toBeNull());

    await act(async () => {
      await expect(result.current?.onCreate(CREATE_REQUEST)).rejects.toThrow('bind boom');
    });

    expect(addRootByPathSpy).toHaveBeenCalledWith('/managed/app/bright-fox');
    expect(toastSpy).toHaveBeenCalledWith({
      description: 'Created the worktree, but binding the thread failed: bind boom',
      title: 'Worktree created, but binding failed',
      variant: 'destructive',
    });
    expect(toastSpy).toHaveBeenCalledTimes(1);
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

  it('refreshes server-resolved create context on every sheet open', async () => {
    const { result } = renderHook(() => useWorktreeMode(ARGS));
    await waitFor(() => expect(result.current?.createDisabledReason).toBeNull());

    await act(async () => {
      await result.current?.onOpenCreateSheet();
    });
    expect(createContextSpy).toHaveBeenCalledWith({ rootId: 'r-1' });
    expect(result.current).toMatchObject({
      defaultName: 'bright-fox',
      managedParentPath: '/managed/app-slug',
    });

    createContextSpy.mockResolvedValueOnce({
      ok: true,
      value: { managedParentPath: '/managed/app-slug', suggestedName: 'quiet-otter' },
    });
    await act(async () => {
      await result.current?.onOpenCreateSheet();
    });
    expect(createContextSpy).toHaveBeenCalledTimes(2);
    expect(result.current?.defaultName).toBe('quiet-otter');
  });

  it('refuses to open the create sheet after the first request, with a toast (BST-1390)', async () => {
    const { result, rerender } = renderHook(
      ({ hasSentFirstRequest }) => useWorktreeMode({ ...ARGS, hasSentFirstRequest }),
      { initialProps: { hasSentFirstRequest: false } }
    );
    await waitFor(() => expect(result.current?.createDisabledReason).toBeNull());
    rerender({ hasSentFirstRequest: true });

    await expect(result.current?.onOpenCreateSheet()).rejects.toThrow(
      'Create a worktree before sending the first request.'
    );
    expect(toastSpy).toHaveBeenCalledWith({
      description: 'Create a worktree before sending the first request.',
      title: 'Could not open worktree creation',
      variant: 'destructive',
    });
    expect(createContextSpy).not.toHaveBeenCalled();
  });

  it('rejects a create-context failure, toasts it, and keeps the last good context', async () => {
    const { result } = renderHook(() => useWorktreeMode(ARGS));
    await act(async () => {
      await result.current?.onOpenCreateSheet();
    });
    createContextSpy.mockResolvedValueOnce({ error: 'inventory unavailable', ok: false });

    await act(async () => {
      await expect(result.current?.onOpenCreateSheet()).rejects.toThrow('inventory unavailable');
    });

    expect(result.current).toMatchObject({
      defaultName: 'bright-fox',
      managedParentPath: '/managed/app-slug',
    });
    expect(toastSpy).toHaveBeenCalledWith({
      description: 'inventory unavailable',
      title: 'Could not prepare worktree creation',
      variant: 'destructive',
    });
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

  it('shows the current worktree on initial mount, without the picker ever being opened (BST-1390)', async () => {
    // A thread that reloads already bound to a worktree must resolve
    // `worktree` from `list()` on its own — nothing in a real reload opens
    // the picker or runs a create/archive/branch mutation first.
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
          setupReason: null,
          setupStatus: 'none',
          trust: 'validated',
          trustReason: null,
          usable: true,
        },
      ],
    });
    const { result } = renderHook(() =>
      useWorktreeMode({ ...ARGS, checkout: { mode: 'worktree', worktreeId: 'w-1' } })
    );
    await waitFor(() =>
      expect(result.current?.worktree).toMatchObject({ name: 'bright-fox', worktreeId: 'w-1' })
    );
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it('wires createBranchHere only for the current managed detached worktree', async () => {
    const detached: WorktreeListEntry = {
      branch: null,
      containment: ['r-1'],
      detached: true,
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
      setupReason: null,
      setupStatus: 'none',
      trust: 'validated',
      trustReason: null,
      usable: true,
    };
    listSpy.mockResolvedValue({ ok: true, value: [detached] });
    const { result, rerender } = renderHook(
      ({ entry }) => {
        listSpy.mockResolvedValue({ ok: true, value: [entry] });
        return useWorktreeMode({
          ...ARGS,
          checkout: { mode: 'worktree', worktreeId: 'w-1' },
        });
      },
      { initialProps: { entry: detached } }
    );
    act(() => result.current?.onOpenPicker());
    await waitFor(() => expect(result.current?.onCreateBranchHere).toEqual(expect.any(Function)));

    await act(async () => {
      await result.current?.onCreateBranchHere?.('bs/bright-fox');
    });

    expect(createBranchHereSpy).toHaveBeenCalledWith({
      branch: 'bs/bright-fox',
      worktreeId: 'w-1',
    });
    // Mount (eager, so a reload sees its worktree without opening the picker)
    // + onOpenPicker + the post-createBranchHere refresh.
    expect(listSpy).toHaveBeenCalledTimes(3);
    expect(toastSpy).toHaveBeenCalledWith({
      description: 'Branch bs/bright-fox is now checked out in bright-fox.',
      title: 'Branch created',
    });

    rerender({ entry: { ...detached, detached: false } });
    act(() => result.current?.onOpenPicker());
    await waitFor(() => expect(result.current?.onCreateBranchHere).toBeUndefined());

    rerender({ entry: { ...detached, managed: false } });
    act(() => result.current?.onOpenPicker());
    await waitFor(() => expect(result.current?.onCreateBranchHere).toBeUndefined());
  });

  it('rejects and toasts when createBranchHere fails', async () => {
    listSpy.mockResolvedValue({
      ok: true,
      value: [
        {
          branch: null,
          containment: ['r-1'],
          detached: true,
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
          setupReason: null,
          setupStatus: 'none',
          trust: 'validated',
          trustReason: null,
          usable: true,
        },
      ],
    });
    createBranchHereSpy.mockResolvedValue({ error: 'branch already exists', ok: false });
    const { result } = renderHook(() =>
      useWorktreeMode({ ...ARGS, checkout: { mode: 'worktree', worktreeId: 'w-1' } })
    );
    act(() => result.current?.onOpenPicker());
    await waitFor(() => expect(result.current?.onCreateBranchHere).toEqual(expect.any(Function)));

    await act(async () => {
      await expect(result.current?.onCreateBranchHere?.('bs/bright-fox')).rejects.toThrow(
        'branch already exists'
      );
    });
    expect(toastSpy).toHaveBeenCalledWith({
      description: 'branch already exists',
      title: 'Branch creation failed',
      variant: 'destructive',
    });
  });

  it.each([
    [
      { disabledReason: 'should not be set', usable: true },
      'Usable worktree "/managed/app/broken" unexpectedly has a disabled reason.',
    ],
    [
      { disabledReason: null, usable: false },
      'Unusable worktree "/managed/app/broken" is missing its disabled reason.',
    ],
  ] as const)(
    'surfaces ledger contract violations as unusable options',
    async (violation, detail) => {
      listSpy.mockResolvedValue({
        ok: true,
        value: [
          {
            branch: null,
            containment: ['r-1'],
            detached: true,
            externalTool: null,
            id: 'w-broken',
            lockedReason: null,
            managed: true,
            name: 'broken',
            path: '/managed/app/broken',
            provenance: 'both',
            remedy: null,
            repositoryRoot: '/work/app',
            rootId: 'r-1',
            setupReason: null,
            setupStatus: 'none',
            trust: 'validated',
            trustReason: null,
            ...violation,
          },
        ],
      });
      const { result } = renderHook(() => useWorktreeMode(ARGS));
      act(() => result.current?.onOpenPicker());

      await waitFor(() =>
        expect(result.current?.picker.options[0]).toMatchObject({
          disabledReason: `Ledger contract violation: ${detail}`,
          usable: false,
        })
      );
      expect(loggerErrorSpy).toHaveBeenCalledWith('Ledger contract violation', { detail });
    }
  );

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
