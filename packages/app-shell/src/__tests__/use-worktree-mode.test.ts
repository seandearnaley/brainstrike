import { __resetWorktreeSetupConsentStoreForTests } from '@brainstrike/app-state/stores/worktree-setup-consent-store';
import type { WorktreeListEntry } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseWorktreeModeArgs } from '../hooks/use-worktree-mode';

type FirstRequestState = UseWorktreeModeArgs['firstRequestState'];
const {
  addRootByPathSpy,
  addRootDirectorySpy,
  adoptSpy,
  archiveSpy,
  createBranchHereSpy,
  createContextSpy,
  createSpy,
  getSettingsSpy,
  inspectArchiveSpy,
  listSpy,
  loggerErrorSpy,
  restoreSpy,
  toastSpy,
} = vi.hoisted(() => ({
  addRootByPathSpy: vi.fn(),
  addRootDirectorySpy: vi.fn(),
  adoptSpy: vi.fn(),
  archiveSpy: vi.fn(),
  createBranchHereSpy: vi.fn(),
  createContextSpy: vi.fn(),
  createSpy: vi.fn(),
  getSettingsSpy: vi.fn(),
  inspectArchiveSpy: vi.fn(),
  listSpy: vi.fn(),
  loggerErrorSpy: vi.fn(),
  restoreSpy: vi.fn(),
  toastSpy: vi.fn(),
}));
vi.mock('../worktrees/worktrees-bridge', () => ({
  resolveWorktreesBridge: () => ({
    adopt: adoptSpy,
    archive: archiveSpy,
    checkoutStatus: vi.fn(),
    create: createSpy,
    createBranchHere: createBranchHereSpy,
    createContext: createContextSpy,
    getSettings: getSettingsSpy,
    inspectArchive: inspectArchiveSpy,
    list: listSpy,
    listManagedPaths: vi.fn(),
    restore: restoreSpy,
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
  checkout: { branch: null, mode: 'local' as const, worktreeId: null, worktreePath: null },
  firstRequestState: 'unsent' as const,
  isRepository: true,
  onHandOffToLocal,
  onSelectWorktree,
  primaryRootId: 'r-1',
  primaryRootPath: '/work/app',
  runId: null,
  statusFailure: null,
  threadId: 'thread-1',
};
const WORKTREE_CHECKOUT: UseWorktreeModeArgs['checkout'] = {
  branch: 'bs/bright-fox',
  mode: 'worktree' as const,
  worktreeId: 'w-1',
  worktreePath: '/managed/app/bright-fox',
};
const ARCHIVE_SELECTION_CHANGES = [
  [
    'worktree',
    { checkout: { ...WORKTREE_CHECKOUT, mode: 'local' as const }, threadId: 'thread-1' },
  ],
  ['thread', { checkout: WORKTREE_CHECKOUT, threadId: 'thread-2' }],
] as const;

const CREATE_REQUEST = {
  baseRef: 'main',
  branch: { name: 'bs/bright-fox' },
  name: 'bright-fox',
} as const;

const SINGLE_IGNORED_PREVIEW = {
  confirmationToken: 'ignored-token',
  ignoredEntryCount: 1,
  ignoredTopLevelEntries: ['.env'],
  ignoredTopLevelEntriesTruncated: false,
  ignoredTopLevelEntryCount: 1,
} as const;

function entry(overrides: Partial<WorktreeListEntry> = {}): WorktreeListEntry {
  return {
    branch: 'main',
    containment: ['r-1'],
    createdAt: null,
    detached: false,
    disabledReason: null,
    externalTool: null,
    id: 'w-1',
    lockedReason: null,
    managed: true,
    name: 'bright-fox',
    path: '/managed/app/bright-fox',
    primary: false,
    provenance: 'both',
    remedy: null,
    repoCommonDir: '/repo/.git',
    repositoryRoot: '/work/app',
    rootId: 'r-1',
    rootIdIsExactMount: true,
    setupReason: null,
    setupStatus: 'none',
    trust: 'validated',
    trustReason: null,
    usable: true,
    ...overrides,
  };
}

describe('useWorktreeMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetWorktreeSetupConsentStoreForTests();
    getSettingsSpy.mockResolvedValue({
      ok: true,
      value: {
        isDefaultDirectory: true,
        managedDirectory: '/home/me/.brainstrike/worktrees',
        setupCommand: null,
      },
    });
    listSpy.mockResolvedValue({ ok: true, value: [] });
    archiveSpy.mockResolvedValue({ ok: true, value: null });
    inspectArchiveSpy.mockResolvedValue({
      ok: true,
      value: {
        confirmationToken: null,
        ignoredEntryCount: 0,
        ignoredTopLevelEntries: [],
        ignoredTopLevelEntriesTruncated: false,
        ignoredTopLevelEntryCount: 0,
      },
    });
    createBranchHereSpy.mockResolvedValue({ ok: true, value: null });
    createContextSpy.mockResolvedValue({
      ok: true,
      value: {
        managedParentPath: '/managed/app-slug',
        repositorySetup: null,
        suggestedName: 'bright-fox',
      },
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
      ({ firstRequestState }) =>
        useWorktreeMode({
          ...ARGS,
          checkout: WORKTREE_CHECKOUT,
          firstRequestState,
        }),
      { initialProps: { firstRequestState: 'unsent' as FirstRequestState } }
    );
    await waitFor(() => expect(result.current?.createDisabledReason).toBeNull());

    rerender({ firstRequestState: 'sent' });

    expect(result.current?.createDisabledReason).toContain('first request');
    expect(result.current?.onHandOffToLocal).toBeDefined();
  });

  it('disables and rejects worktree creation when no thread is selected', async () => {
    const { result } = renderHook(() =>
      useWorktreeMode({ ...ARGS, firstRequestState: 'no-thread' })
    );
    await waitFor(() => expect(result.current?.createDisabledReason).toBe('No thread selected.'));

    await act(async () => {
      await expect(result.current?.onCreate(CREATE_REQUEST)).rejects.toThrow('No thread selected.');
    });

    expect(toastSpy).toHaveBeenCalledWith({
      description: 'No thread selected.',
      title: 'Could not create a worktree',
      variant: 'destructive',
    });
    expect(createSpy).not.toHaveBeenCalled();
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
      description:
        'Created the worktree at /managed/app/bright-fox, but binding the thread failed: bind boom. Use "Use existing worktree…" to reconnect this thread to it.',
      title: 'Worktree created, but binding failed',
      variant: 'destructive',
    });
    expect(toastSpy).toHaveBeenCalledTimes(1);
  });

  it('hands off before archiving, and archives nothing when the hand-off fails', async () => {
    onHandOffToLocal.mockRejectedValueOnce(new Error('handoff boom'));
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, checkout: WORKTREE_CHECKOUT }));
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));

    act(() => result.current?.onArchive?.());

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        description: 'handoff boom',
        title: 'Could not hand off to Local — worktree not archived',
        variant: 'destructive',
      })
    );
    // A failed hand-off must never reach the archive call: a worktree
    // archived out from under a thread that is NOT actually Local yet is
    // exactly the stranded state this ordering exists to prevent.
    expect(archiveSpy).not.toHaveBeenCalled();
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Thread handed off — worktree not archived' })
    );
  });

  it('requires confirmation before handing off and archiving ignored files', async () => {
    inspectArchiveSpy.mockResolvedValueOnce({
      ok: true,
      value: SINGLE_IGNORED_PREVIEW,
    });
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, checkout: WORKTREE_CHECKOUT }));

    act(() => result.current?.onArchive?.());
    await waitFor(() => expect(result.current?.archiveConfirmation).not.toBeNull());
    expect(onHandOffToLocal).not.toHaveBeenCalled();
    expect(archiveSpy).not.toHaveBeenCalled();

    act(() => result.current?.archiveConfirmation?.onConfirm());
    await waitFor(() => expect(archiveSpy).toHaveBeenCalledTimes(1));
    expect(onHandOffToLocal).toHaveBeenCalledTimes(1);
    expect(archiveSpy).toHaveBeenCalledWith({
      confirmIgnoredEntries: 'ignored-token',
      worktreeId: 'w-1',
    });
  });

  it.each(ARCHIVE_SELECTION_CHANGES)(
    'cancels ignored-file confirmation when the selected %s changes',
    async (_identity, changedSelection) => {
      inspectArchiveSpy.mockResolvedValueOnce({ ok: true, value: SINGLE_IGNORED_PREVIEW });
      const initialSelection = { checkout: WORKTREE_CHECKOUT, threadId: 'thread-1' };
      const { rerender, result } = renderHook(
        ({ checkout, threadId }) => useWorktreeMode({ ...ARGS, checkout, threadId }),
        { initialProps: initialSelection }
      );
      act(() => result.current?.onArchive?.());
      await waitFor(() => expect(result.current?.archiveConfirmation).not.toBeNull());
      rerender(changedSelection);
      await waitFor(() => expect(result.current?.archiveConfirmation).toBeNull());
      rerender(initialSelection);
      expect(result.current?.archiveConfirmation).toBeNull();
      expect(archiveSpy).not.toHaveBeenCalled();
    }
  );

  it('archives only after a successful hand-off, in that order', async () => {
    const callOrder: string[] = [];
    onHandOffToLocal.mockImplementationOnce(() => {
      callOrder.push('handOff');
      return Promise.resolve();
    });
    archiveSpy.mockImplementationOnce(() => {
      callOrder.push('archive');
      return Promise.resolve({ ok: true, value: null });
    });
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, checkout: WORKTREE_CHECKOUT }));
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));

    act(() => result.current?.onArchive?.());

    await waitFor(() => expect(archiveSpy).toHaveBeenCalledTimes(1));
    expect(callOrder).toEqual(['handOff', 'archive']);
    expect(archiveSpy).toHaveBeenCalledWith({ worktreeId: 'w-1' });
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(3));
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('toasts an honest failure when archiving fails after a successful hand-off', async () => {
    archiveSpy.mockResolvedValueOnce({ error: 'worktree has uncommitted changes', ok: false });
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, checkout: WORKTREE_CHECKOUT }));
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));

    act(() => result.current?.onArchive?.());

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        description: 'worktree has uncommitted changes',
        title: 'Thread handed off — worktree not archived',
        variant: 'destructive',
      })
    );
    // The hand-off itself already landed — the thread is safely Local, so no
    // second inventory read is needed for a mutation that never happened.
    expect(listSpy).toHaveBeenCalledTimes(2);
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
      value: {
        managedParentPath: '/managed/app-slug',
        repositorySetup: null,
        suggestedName: 'quiet-otter',
      },
    });
    await act(async () => {
      await result.current?.onOpenCreateSheet();
    });
    expect(createContextSpy).toHaveBeenCalledTimes(2);
    expect(result.current?.defaultName).toBe('quiet-otter');
  });

  // Repository setup script consent (BST-1455) — the create sheet's
  // Allow/Skip gate, standing-decision persistence, hash-staleness
  // re-prompting, and the branch-menu create path — is covered in
  // `use-worktree-mode-repository-setup-consent.test.ts` (split out to keep
  // both files under the line-count ceiling).

  it('refuses to open the create sheet after the first request, with a toast (BST-1390)', async () => {
    const { result, rerender } = renderHook(
      ({ firstRequestState }) => useWorktreeMode({ ...ARGS, firstRequestState }),
      { initialProps: { firstRequestState: 'unsent' as FirstRequestState } }
    );
    await waitFor(() => expect(result.current?.createDisabledReason).toBeNull());
    rerender({ firstRequestState: 'sent' });

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

  it('refuses to open the create sheet when no thread is selected', async () => {
    const { result } = renderHook(() =>
      useWorktreeMode({ ...ARGS, firstRequestState: 'no-thread' })
    );
    await waitFor(() => expect(result.current?.createDisabledReason).toBe('No thread selected.'));

    await expect(result.current?.onOpenCreateSheet()).rejects.toThrow('No thread selected.');
    expect(toastSpy).toHaveBeenCalledWith({
      description: 'No thread selected.',
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
          createdAt: null,
          detached: true,
          disabledReason:
            "This worktree isn't inside any workspace folder yet — grant access to use it here.",
          externalTool: 'codex',
          id: null,
          lockedReason: null,
          managed: false,
          name: 'codex-one',
          path: '/Users/me/.codex/worktrees/codex-one',
          primary: false,
          provenance: 'scanned',
          remedy: 'grant-access',
          repoCommonDir: '/repo/.git',
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

  it('renders the primary checkout as a disabled picker row with its stated reason', async () => {
    listSpy.mockResolvedValue({
      ok: true,
      value: [
        entry({
          disabledReason:
            "This is the repository's primary checkout — use Hand off to Local instead.",
          id: null,
          name: 'brainstrike',
          path: '/repo',
          primary: true,
          usable: false,
        }),
      ],
    });

    const { result } = renderHook(() => useWorktreeMode(ARGS));
    await waitFor(() => expect(result.current?.picker.options).toHaveLength(1));

    const [option] = result.current?.picker.options ?? [];
    expect(option?.usable).toBe(false);
    expect(option?.disabledReason).toBe(
      "This is the repository's primary checkout — use Hand off to Local instead."
    );
  });

  it('uses persisted setup status and reason for the selected worktree summary', async () => {
    listSpy.mockResolvedValue({
      ok: true,
      value: [
        {
          branch: 'bs/bright-fox',
          containment: ['r-1'],
          createdAt: null,
          detached: false,
          disabledReason: null,
          externalTool: null,
          id: 'w-1',
          lockedReason: null,
          managed: true,
          name: 'bright-fox',
          path: '/managed/app/bright-fox',
          primary: false,
          provenance: 'both',
          remedy: null,
          repoCommonDir: '/repo/.git',
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
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, checkout: WORKTREE_CHECKOUT }));
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
          createdAt: null,
          detached: false,
          disabledReason: null,
          externalTool: null,
          id: 'w-1',
          lockedReason: null,
          managed: true,
          name: 'bright-fox',
          path: '/managed/app/bright-fox',
          primary: false,
          provenance: 'both',
          remedy: null,
          repoCommonDir: '/repo/.git',
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
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, checkout: WORKTREE_CHECKOUT }));
    await waitFor(() =>
      expect(result.current?.worktree).toMatchObject({ name: 'bright-fox', worktreeId: 'w-1' })
    );
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it('retries a failed mount list once for a bound worktree and stops after success', async () => {
    listSpy.mockRejectedValueOnce(new Error('IPC is not ready')).mockResolvedValue({
      ok: true,
      value: [
        {
          branch: 'bs/bright-fox',
          containment: ['r-1'],
          createdAt: null,
          detached: false,
          disabledReason: null,
          externalTool: null,
          id: 'w-1',
          lockedReason: null,
          managed: true,
          name: 'bright-fox',
          path: '/managed/app/bright-fox',
          primary: false,
          provenance: 'both',
          remedy: null,
          repoCommonDir: '/repo/.git',
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
    const { result, rerender } = renderHook(() =>
      useWorktreeMode({ ...ARGS, checkout: WORKTREE_CHECKOUT })
    );

    // The bound-checkout fallback renders `{ name, worktreeId }` from the
    // persisted checkout on the very first render, so a worktree match can
    // pass before the retry's list() call has even fired — the spy count is
    // the only signal that discriminates the retry from the fallback.
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current).toMatchObject({
        disabledReason: null,
        picker: { options: [{ current: true, worktreeId: 'w-1' }] },
        worktree: { name: 'bright-fox', worktreeId: 'w-1' },
      })
    );

    rerender();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  it('refreshes a missing bound id once and renders its persisted basename with a diagnostic', async () => {
    const { result, rerender } = renderHook(() =>
      useWorktreeMode({ ...ARGS, checkout: WORKTREE_CHECKOUT })
    );

    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(result.current).toMatchObject({
        disabledReason: 'The bound worktree w-1 is missing from the refreshed worktree list.',
        worktree: {
          name: 'bright-fox',
          path: '/managed/app/bright-fox',
          worktreeId: 'w-1',
        },
      })
    );

    rerender();
    await act(async () => {
      await Promise.resolve();
    });
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  it('wires createBranchHere only for the current managed detached worktree', async () => {
    const detached: WorktreeListEntry = {
      branch: null,
      containment: ['r-1'],
      createdAt: null,
      detached: true,
      disabledReason: null,
      externalTool: null,
      id: 'w-1',
      lockedReason: null,
      managed: true,
      name: 'bright-fox',
      path: '/managed/app/bright-fox',
      primary: false,
      provenance: 'both',
      remedy: null,
      repoCommonDir: '/repo/.git',
      repositoryRoot: '/work/app',
      rootId: 'r-1',
      rootIdIsExactMount: true,
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
          checkout: WORKTREE_CHECKOUT,
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
          createdAt: null,
          detached: true,
          disabledReason: null,
          externalTool: null,
          id: 'w-1',
          lockedReason: null,
          managed: true,
          name: 'bright-fox',
          path: '/managed/app/bright-fox',
          primary: false,
          provenance: 'both',
          remedy: null,
          repoCommonDir: '/repo/.git',
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
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, checkout: WORKTREE_CHECKOUT }));
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
            createdAt: null,
            detached: true,
            externalTool: null,
            id: 'w-broken',
            lockedReason: null,
            managed: true,
            name: 'broken',
            path: '/managed/app/broken',
            primary: false,
            provenance: 'both',
            remedy: null,
            repoCommonDir: '/repo/.git',
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

  // Selecting an unmanaged row is unreachable through the real picker
  // (`resolveUsability` never marks a row without a ledger id `usable`, and
  // the picker UI disables every unusable option), but `onSelect` itself
  // takes whatever option it is given — this pins the defensive refusal
  // rather than a silent adopt-on-select, now that adoption lives on the
  // Worktree Map's card action (Task 6) and the agent tool (Task 10), not
  // here. A directly-constructed unmanaged option (bypassing the picker's
  // own disabling) still refuses loudly instead of quietly binding a
  // nonexistent worktree id.
  it('refuses to bind an unmanaged option instead of silently adopting it', async () => {
    listSpy.mockResolvedValue({
      ok: true,
      value: [entry({ id: null, managed: false, name: 'x', path: '/repo/.claude/worktrees/x' })],
    });

    const { result } = renderHook(() => useWorktreeMode(ARGS));
    await waitFor(() => expect(result.current?.picker.options).toHaveLength(1));
    act(() => {
      result.current?.picker.onSelect(result.current.picker.options[0] as never);
    });

    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(toastSpy).toHaveBeenCalledWith({
      description: 'The worktree at /repo/.claude/worktrees/x is not yet managed.',
      title: 'Could not use that worktree',
      variant: 'destructive',
    });
    expect(onSelectWorktree).not.toHaveBeenCalled();
    expect(adoptSpy).not.toHaveBeenCalled();
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
