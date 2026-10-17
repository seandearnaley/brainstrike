import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import type { WorkspaceBarMode } from '@brainstrike/assistant-ui';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { branchSwitcherSpy, loggerErrorSpy, toastSpy, worktreeModeSpy } = vi.hoisted(() => ({
  branchSwitcherSpy: vi.fn(),
  loggerErrorSpy: vi.fn(),
  toastSpy: vi.fn(),
  worktreeModeSpy: vi.fn(),
}));

vi.mock('../hooks/use-branch-switcher', () => ({ useBranchSwitcher: branchSwitcherSpy }));
vi.mock('../hooks/use-worktree-mode', () => ({ useWorktreeMode: worktreeModeSpy }));
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
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  toast: toastSpy,
}));

import { type UseWorkspaceBarModeArgs, useWorkspaceBarMode } from '../hooks/use-workspace-bar-mode';
import { useWorktreeCheckoutIntentStore } from '../stores/worktree-checkout-intent-store';

const mode = (overrides: Partial<WorkspaceBarMode> = {}): WorkspaceBarMode => ({
  archiveConfirmation: null,
  baseRefs: [{ label: 'Current branch', value: 'HEAD' }],
  createDisabledReason: null,
  defaultBranchPrefix: 'bs/',
  defaultName: 'bright-fox',
  disabledReason: null,
  localPath: '/work/app',
  managedParentPath: '/managed/app-slug',
  onArchive: undefined,
  onCreate: vi.fn(() => Promise.resolve()),
  onCreateBranchHere: undefined,
  onHandOffToLocal: undefined,
  onOpenCreateSheet: vi.fn(() => Promise.resolve()),
  onOpenPicker: vi.fn(),
  onOpenTerminal: undefined,
  onReveal: undefined,
  pending: false,
  picker: {
    error: null,
    loading: false,
    onGrantAccess: undefined,
    onOpenChange: vi.fn(),
    onSelect: vi.fn(),
    open: false,
    options: [],
  },
  repositorySetupConsent: null,
  setupSummary: '',
  worktree: null,
  ...overrides,
});

const thread = {
  createdAt: new Date('2026-08-25T00:00:00.000Z'),
  id: 'thread-1',
  metadata: {},
  resourceId: 'workspace-1',
  title: 'Thread',
  updatedAt: new Date('2026-08-25T00:00:00.000Z'),
} satisfies AssistantMemoryThread;

function renderComposition() {
  return renderHook(() =>
    useWorkspaceBarMode({
      checkout: { ahead: 0, behind: 0, branch: 'main', dirty: true },
      checkoutFailure: null,
      checkoutSettled: true,
      foldersPending: false,
      onHandOffToLocal: vi.fn(),
      onSelectWorktree: vi.fn(),
      primaryRootId: 'r-1',
      primaryRootPath: '/work/app',
      selectedMemoryThreadId: thread.id,
      selectedThread: thread,
      worktreeCheckout: {
        branch: null,
        mode: 'local',
        worktreeId: null,
        worktreePath: null,
      },
    })
  );
}

describe('useWorkspaceBarMode branch escape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    branchSwitcherSpy.mockReturnValue(undefined);
  });

  it('treats an unhydrated selected thread as loading, never as pre-first-request', () => {
    worktreeModeSpy.mockReturnValue(mode({ createDisabledReason: 'Thread is still loading.' }));
    renderHook(() =>
      useWorkspaceBarMode({
        checkout: { ahead: 0, behind: 0, branch: 'main', dirty: false },
        checkoutFailure: null,
        checkoutSettled: true,
        foldersPending: false,
        onHandOffToLocal: vi.fn(),
        onSelectWorktree: vi.fn(),
        primaryRootId: 'r-1',
        primaryRootPath: '/work/app',
        selectedMemoryThreadId: 'thread-1',
        selectedThread: undefined,
        worktreeCheckout: {
          branch: null,
          mode: 'local',
          worktreeId: null,
          worktreePath: null,
        },
      })
    );

    expect(worktreeModeSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ firstRequestState: 'loading' })
    );
    expect(branchSwitcherSpy.mock.calls.at(-1)?.[0]?.onSwitchInNewWorktree).toBeUndefined();
  });

  it('treats no selected thread as unselected, not as loading', () => {
    worktreeModeSpy.mockReturnValue(mode({ createDisabledReason: 'No thread selected.' }));
    renderHook(() =>
      useWorkspaceBarMode({
        checkout: { ahead: 0, behind: 0, branch: 'main', dirty: false },
        checkoutFailure: null,
        checkoutSettled: true,
        foldersPending: false,
        onHandOffToLocal: vi.fn(),
        onSelectWorktree: vi.fn(),
        primaryRootId: 'r-1',
        primaryRootPath: '/work/app',
        selectedMemoryThreadId: undefined,
        selectedThread: undefined,
        worktreeCheckout: {
          branch: null,
          mode: 'local',
          worktreeId: null,
          worktreePath: null,
        },
      })
    );

    expect(worktreeModeSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ firstRequestState: 'no-thread' })
    );
    expect(branchSwitcherSpy.mock.calls.at(-1)?.[0]?.onSwitchInNewWorktree).toBeUndefined();
  });

  it('supplies the escape only when creation is enabled and only logs a rejection', async () => {
    const onCreate = vi.fn(() => Promise.reject(new Error('bridge create failed')));
    worktreeModeSpy.mockReturnValue(mode({ onCreate }));
    renderComposition();
    const branchEscape = branchSwitcherSpy.mock.calls.at(-1)?.[0]?.onSwitchInNewWorktree;
    expect(branchEscape).toEqual(expect.any(Function));

    act(() => branchEscape?.('feature/alpha'));

    await waitFor(() =>
      expect(loggerErrorSpy).toHaveBeenCalledWith('Switch in a new worktree failed', {
        error: expect.any(Error),
      })
    );
    expect(toastSpy).not.toHaveBeenCalled();
    expect(onCreate).toHaveBeenCalledWith({
      baseRef: 'feature/alpha',
      branch: { detached: true },
      name: 'feature-alpha',
    });
  });

  it('omits the escape capability when creation has a disabled reason', () => {
    worktreeModeSpy.mockReturnValue(
      mode({ createDisabledReason: 'Create a worktree before sending the first request.' })
    );
    renderComposition();

    expect(branchSwitcherSpy.mock.calls.at(-1)?.[0]?.onSwitchInNewWorktree).toBeUndefined();
  });
});

describe('useWorkspaceBarMode checkout readiness (BST-2129)', () => {
  const args: UseWorkspaceBarModeArgs = {
    checkout: undefined,
    checkoutFailure: null,
    checkoutSettled: false,
    foldersPending: false,
    onHandOffToLocal: vi.fn(),
    onSelectWorktree: vi.fn(),
    primaryRootId: 'r-1',
    primaryRootPath: '/work/app',
    selectedMemoryThreadId: thread.id,
    selectedThread: thread,
    worktreeCheckout: {
      branch: null,
      mode: 'local',
      worktreeId: null,
      worktreePath: null,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    branchSwitcherSpy.mockReturnValue(undefined);
  });

  it('offers no mode chip while the root is unknown, then the real one once it settles', () => {
    // useWorktreeMode reads a still-loading checkout as "Not a git repository".
    worktreeModeSpy.mockImplementation(({ isRepository }: { isRepository: boolean }) =>
      isRepository ? mode() : mode({ disabledReason: 'Not a git repository' })
    );
    const { rerender, result } = renderHook(
      (props: UseWorkspaceBarModeArgs) => useWorkspaceBarMode(props),
      { initialProps: args }
    );

    expect(result.current.mode).toBeUndefined();
    expect(branchSwitcherSpy.mock.calls.at(-1)?.[0]?.onSwitchInNewWorktree).toBeUndefined();

    rerender({
      ...args,
      checkout: { ahead: 0, behind: 0, branch: 'main', dirty: false },
      checkoutFailure: null,
      checkoutSettled: true,
    });
    expect(result.current.mode?.disabledReason).toBeNull();
    expect(branchSwitcherSpy.mock.calls.at(-1)?.[0]?.onSwitchInNewWorktree).toEqual(
      expect.any(Function)
    );
  });

  it('hands a failed status read to the mode, so it is not called a non-repository', () => {
    worktreeModeSpy.mockReturnValue(mode({ disabledReason: 'Git status could not be read: boom' }));
    renderHook(() =>
      useWorkspaceBarMode({ ...args, checkoutFailure: 'boom', checkoutSettled: true })
    );

    expect(worktreeModeSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ isRepository: false, statusFailure: 'boom' })
    );
  });

  it('still explains a settled root that is not a repository', () => {
    worktreeModeSpy.mockReturnValue(mode({ disabledReason: 'Not a git repository' }));
    const { result } = renderHook(() => useWorkspaceBarMode({ ...args, checkoutSettled: true }));

    expect(worktreeModeSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ isRepository: false })
    );
    expect(result.current.mode?.disabledReason).toBe('Not a git repository');
  });
});

describe('useWorkspaceBarMode worktree map checkout intent', () => {
  const onHandOffToLocal = vi.fn(() => Promise.resolve());
  const onSelectWorktree = vi.fn(() => Promise.resolve());
  const args = {
    checkout: { ahead: 0, behind: 0, branch: 'main', dirty: true },
    checkoutFailure: null,
    checkoutSettled: true,
    foldersPending: false,
    onHandOffToLocal,
    onSelectWorktree,
    primaryRootId: 'r-1',
    primaryRootPath: '/work/app',
    selectedMemoryThreadId: thread.id,
    selectedThread: thread,
    worktreeCheckout: {
      branch: null,
      mode: 'local',
      worktreeId: null,
      worktreePath: null,
    },
  } satisfies UseWorkspaceBarModeArgs;

  beforeEach(() => {
    vi.clearAllMocks();
    branchSwitcherSpy.mockReturnValue(undefined);
    worktreeModeSpy.mockReturnValue(mode());
    useWorktreeCheckoutIntentStore.setState({ pending: null });
  });

  it('binds the published worktree to the selected thread exactly once', async () => {
    useWorktreeCheckoutIntentStore.getState().publish({
      branch: 'bs/bright-fox',
      path: '/wt',
      threadId: 'thread-1',
      worktreeId: 'wt-1',
    });

    const { rerender } = renderHook(() => useWorkspaceBarMode(args));
    await waitFor(() => expect(onSelectWorktree).toHaveBeenCalledTimes(1));
    expect(onSelectWorktree).toHaveBeenCalledWith({
      branch: 'bs/bright-fox',
      path: '/wt',
      worktreeId: 'wt-1',
    });
    expect(onHandOffToLocal).not.toHaveBeenCalled();

    rerender();
    expect(onSelectWorktree).toHaveBeenCalledTimes(1);
  });

  it("waits for the selected thread's folders before binding a published worktree", async () => {
    useWorktreeCheckoutIntentStore.getState().publish({
      branch: 'bs/bright-fox',
      path: '/wt',
      threadId: 'thread-1',
      worktreeId: 'wt-1',
    });

    // A freshly mounted bar resolves the thread's primary folder asynchronously;
    // binding before it settles derives from no primary at all.
    const { rerender } = renderHook(
      ({ foldersPending }: { foldersPending: boolean }) =>
        useWorkspaceBarMode({ ...args, foldersPending, primaryRootId: undefined }),
      { initialProps: { foldersPending: true } }
    );
    await Promise.resolve();
    expect(onSelectWorktree).not.toHaveBeenCalled();
    expect(useWorktreeCheckoutIntentStore.getState().pending).not.toBeNull();

    rerender({ foldersPending: false });
    await waitFor(() => expect(onSelectWorktree).toHaveBeenCalledTimes(1));
    expect(useWorktreeCheckoutIntentStore.getState().pending).toBeNull();
  });

  it('hands off to Local when the intent carries a null worktree id', async () => {
    useWorktreeCheckoutIntentStore
      .getState()
      .publish({ branch: null, path: '/repo', threadId: 'thread-1', worktreeId: null });

    renderHook(() => useWorkspaceBarMode(args));

    await waitFor(() => expect(onHandOffToLocal).toHaveBeenCalledTimes(1));
    expect(onSelectWorktree).not.toHaveBeenCalled();
  });

  it('reports a refused bind visibly instead of leaving the new thread Local in silence', async () => {
    const refusal = new Error('This host has no live thread workspace binding capability');
    onSelectWorktree.mockRejectedValueOnce(refusal);
    useWorktreeCheckoutIntentStore.getState().publish({
      branch: 'bs/bright-fox',
      path: '/wt',
      threadId: 'thread-1',
      worktreeId: 'wt-1',
    });

    renderHook(() => useWorkspaceBarMode(args));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ description: refusal.message, variant: 'destructive' })
      )
    );
    expect(loggerErrorSpy).toHaveBeenCalledWith('worktree map checkout intent failed', {
      error: refusal,
      threadId: 'thread-1',
    });
  });

  it('reports a refused hand-off to Local visibly too', async () => {
    const refusal = new Error('Folders are still loading — try again in a moment.');
    onHandOffToLocal.mockRejectedValueOnce(refusal);
    useWorktreeCheckoutIntentStore
      .getState()
      .publish({ branch: null, path: '/repo', threadId: 'thread-1', worktreeId: null });

    renderHook(() => useWorkspaceBarMode(args));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ description: refusal.message, variant: 'destructive' })
      )
    );
    expect(onSelectWorktree).not.toHaveBeenCalled();
  });

  it('ignores an intent published for a different thread', async () => {
    useWorktreeCheckoutIntentStore
      .getState()
      .publish({ branch: null, path: '/wt', threadId: 'other', worktreeId: 'wt-9' });

    renderHook(() => useWorkspaceBarMode(args));

    await Promise.resolve();
    expect(onSelectWorktree).not.toHaveBeenCalled();
    expect(onHandOffToLocal).not.toHaveBeenCalled();
    expect(useWorktreeCheckoutIntentStore.getState().pending).not.toBeNull();
  });
});
