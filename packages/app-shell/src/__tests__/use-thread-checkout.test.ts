import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useThreadCheckout } from '../hooks/use-thread-checkout';
import type { ThreadCheckoutFolders, ThreadCheckoutWrite } from '../hooks/use-thread-folders-write';

const { loggerErrorSpy, loggerWarnSpy, toastSpy } = vi.hoisted(() => ({
  loggerErrorSpy: vi.fn(),
  loggerWarnSpy: vi.fn(),
  toastSpy: vi.fn(),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => ({
    debug: vi.fn(),
    error: loggerErrorSpy,
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: loggerWarnSpy,
  }),
}));
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  toast: toastSpy,
}));

const enqueue = vi.fn(
  async (
    _threadId: string | undefined,
    derive: (current: ThreadCheckoutFolders) => ThreadCheckoutWrite | null
  ) => {
    derive({
      checkoutLocalRootId: undefined,
      metadataPending: false,
      primaryRoot: {
        displayName: 'app',
        path: '/work/app',
        rootId: 'r-local',
      },
      primaryRootId: 'r-local',
      secondaryRootIds: [],
      secondaryRoots: [],
      threadId: 't-1',
    });
  }
);
const resolveRootIdForPath = vi.fn(() => Promise.resolve('r-worktree'));

const ARGS = {
  enqueueThreadFoldersWrite: enqueue,
  resolveRootIdForPath,
  selectedMemoryThreadId: 't-1',
  threadMetadata: undefined,
};

describe('useThreadCheckout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveRootIdForPath.mockResolvedValue('r-worktree');
  });

  it('reads Local when the thread has no checkout metadata', () => {
    const { result } = renderHook(() => useThreadCheckout(ARGS));
    expect(result.current.checkout).toEqual({
      mode: 'local',
      worktreeId: null,
      worktreePath: null,
    });
  });

  it('reads the worktree checkout from metadata', () => {
    const { result } = renderHook(() =>
      useThreadCheckout({
        ...ARGS,
        threadMetadata: {
          checkoutBranch: 'bs/bright-fox',
          checkoutLocalRootId: 'r-local',
          checkoutMode: 'worktree',
          checkoutWorktreeId: 'w-1',
          checkoutWorktreePath: '/managed/app/bright-fox',
        },
      })
    );
    expect(result.current.checkout).toEqual({
      mode: 'worktree',
      worktreeId: 'w-1',
      worktreePath: '/managed/app/bright-fox',
    });
  });

  it('writes the checkout fields AND re-binds the primary root, in ONE write', async () => {
    const { result } = renderHook(() => useThreadCheckout(ARGS));
    await result.current.selectWorktree({
      branch: 'bs/bright-fox',
      path: '/managed/app/bright-fox',
      worktreeId: 'w-1',
    });
    const derive = enqueue.mock.calls[0]?.[1] as (current: unknown) => {
      binding: Record<string, string>;
    };
    const write = derive({
      checkoutLocalRootId: undefined,
      metadataPending: false,
      primaryRoot: {
        displayName: 'app',
        path: '/work/app',
        rootId: 'r-local',
      },
      primaryRootId: 'r-local',
      secondaryRootIds: [],
      secondaryRoots: [],
      threadId: 't-1',
    });
    expect(write.binding).toEqual({
      checkoutBranch: 'bs/bright-fox',
      checkoutLocalRootId: 'r-local',
      checkoutMode: 'worktree',
      checkoutWorktreeId: 'w-1',
      checkoutWorktreePath: '/managed/app/bright-fox',
      operatingRootDisplayName: 'bright-fox',
      operatingRootId: 'r-worktree',
      operatingRootPath: '/managed/app/bright-fox',
    });
  });

  it('remembers the Local root so hand-off can return to it', async () => {
    const { result } = renderHook(() => useThreadCheckout(ARGS));
    await result.current.selectWorktree({
      branch: null,
      path: '/managed/app/bright-fox',
      worktreeId: 'w-1',
    });
    const derive = enqueue.mock.calls[0]?.[1] as (current: unknown) => {
      checkoutLocalRootId: string | undefined;
      ids: readonly string[];
      secondaryRoots: readonly { rootId: string }[];
    };
    const write = derive({
      checkoutLocalRootId: undefined,
      metadataPending: false,
      primaryRoot: {
        displayName: 'app',
        path: '/work/app',
        rootId: 'r-local',
      },
      primaryRootId: 'r-local',
      secondaryRootIds: [],
      secondaryRoots: [],
      threadId: 't-1',
    });
    expect(write.ids).toContain('r-local');
    expect(write.checkoutLocalRootId).toBe('r-local');
    expect(write.secondaryRoots).toContainEqual({
      displayName: 'app',
      path: '/work/app',
      rootId: 'r-local',
    });
  });

  it('clears worktree keys AND re-binds the primary on hand-off, in ONE write', async () => {
    const { result } = renderHook(() =>
      useThreadCheckout({
        ...ARGS,
        threadMetadata: {
          checkoutLocalRootId: 'r-local',
          checkoutMode: 'worktree',
          checkoutWorktreeId: 'w-1',
          checkoutWorktreePath: '/managed/app/bright-fox',
          secondaryRootIds: ['r-local'],
        },
      })
    );
    await result.current.handOffToLocal();
    const derive = enqueue.mock.calls[0]?.[1] as (current: unknown) => {
      binding: Record<string, string | null>;
      checkoutLocalRootId: string | undefined;
      ids: readonly string[];
    };
    const write = derive({
      checkoutLocalRootId: 'r-local',
      metadataPending: false,
      primaryRoot: {
        displayName: 'bright-fox',
        path: '/managed/app/bright-fox',
        rootId: 'r-worktree',
      },
      primaryRootId: 'r-worktree',
      secondaryRootIds: ['r-local'],
      secondaryRoots: [{ displayName: 'app', path: '/work/app', rootId: 'r-local' }],
      threadId: 't-1',
    });
    expect(write.binding).toMatchObject({
      checkoutMode: 'local',
      operatingRootDisplayName: 'app',
      operatingRootId: 'r-local',
      operatingRootPath: '/work/app',
    });
    expect(write.binding['checkoutWorktreeId']).toBeUndefined();
    expect(write.binding['checkoutWorktreePath']).toBeUndefined();
    expect(write.checkoutLocalRootId).toBeUndefined();
    expect(write.ids).toEqual([]);
  });

  it('reads the remembered Local root off the thread metadata', () => {
    const { result } = renderHook(() =>
      useThreadCheckout({
        ...ARGS,
        threadMetadata: {
          checkoutLocalRootId: 'r-local',
          checkoutMode: 'worktree',
          checkoutWorktreeId: 'w-1',
          checkoutWorktreePath: '/managed/app/bright-fox',
          secondaryRootIds: ['r-local'],
        },
      })
    );
    expect(result.current.localRootId).toBe('r-local');
  });

  it('clears checkout while retaining the primary when no Local root was remembered', async () => {
    const { result } = renderHook(() => useThreadCheckout(ARGS));
    await result.current.handOffToLocal();
    const derive = enqueue.mock.calls[0]?.[1];
    const current: ThreadCheckoutFolders = {
      checkoutLocalRootId: undefined,
      metadataPending: false,
      primaryRoot: {
        displayName: 'bright-fox',
        path: '/managed/app/bright-fox',
        rootId: 'r-worktree',
      },
      primaryRootId: 'r-worktree',
      secondaryRootIds: [],
      secondaryRoots: [],
      threadId: 't-1',
    };
    expect(derive?.(current)).toEqual({
      binding: { checkoutMode: 'local' },
      checkoutLocalRootId: undefined,
      ids: [],
      primaryRoot: current.primaryRoot,
      primaryRootId: 'r-worktree',
      secondaryRoots: [],
    });
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      'Hand-off to Local has no recorded Local root; retaining the current folder'
    );
    expect(toastSpy).toHaveBeenCalledWith({
      description:
        'Thread is Local again, but its folder is still the worktree — add a folder to move it.',
      title: "Folder didn't follow",
    });
  });

  it('refuses hand-off when the remembered Local root has no complete roots row', async () => {
    const { result } = renderHook(() => useThreadCheckout(ARGS));
    await result.current.handOffToLocal();
    const derive = enqueue.mock.calls[0]?.[1];
    expect(() =>
      derive?.({
        checkoutLocalRootId: 'r-local',
        metadataPending: false,
        primaryRoot: {
          displayName: 'bright-fox',
          path: '/managed/app/bright-fox',
          rootId: 'r-worktree',
        },
        primaryRootId: 'r-worktree',
        secondaryRootIds: ['r-local'],
        secondaryRoots: [],
        threadId: 't-1',
      })
    ).toThrow(
      'Could not hand off to Local: the tracked local folder (root r-local) is no longer available. Add it back as a folder to try again.'
    );
    expect(loggerErrorSpy).toHaveBeenCalled();
  });

  it('preserves the original primary across a pre-existing secondary and hands back to it', async () => {
    const { result } = renderHook(() => useThreadCheckout(ARGS));
    await result.current.selectWorktree({
      branch: null,
      path: '/managed/app/bright-fox',
      worktreeId: 'w-1',
    });
    const selectDerive = enqueue.mock.calls[0]?.[1];
    const selected = selectDerive?.({
      checkoutLocalRootId: undefined,
      metadataPending: false,
      primaryRoot: { displayName: 'app', path: '/work/app', rootId: 'r-local' },
      primaryRootId: 'r-local',
      secondaryRootIds: ['r-docs'],
      secondaryRoots: [{ displayName: 'docs', path: '/work/docs', rootId: 'r-docs' }],
      threadId: 't-1',
    });

    expect(selected).toMatchObject({
      checkoutLocalRootId: 'r-local',
      ids: ['r-docs', 'r-local'],
      secondaryRoots: [
        { displayName: 'docs', path: '/work/docs', rootId: 'r-docs' },
        { displayName: 'app', path: '/work/app', rootId: 'r-local' },
      ],
    });

    await result.current.handOffToLocal();
    const handOffDerive = enqueue.mock.calls[1]?.[1];
    const handedOff = handOffDerive?.({
      checkoutLocalRootId: 'r-local',
      metadataPending: false,
      primaryRoot: {
        displayName: 'bright-fox',
        path: '/managed/app/bright-fox',
        rootId: 'r-worktree',
      },
      primaryRootId: 'r-worktree',
      secondaryRootIds: ['r-docs', 'r-local'],
      secondaryRoots: [
        { displayName: 'docs', path: '/work/docs', rootId: 'r-docs' },
        { displayName: 'app', path: '/work/app', rootId: 'r-local' },
      ],
      threadId: 't-1',
    });

    expect(handedOff).toMatchObject({
      checkoutLocalRootId: undefined,
      ids: ['r-docs'],
      primaryRoot: { displayName: 'app', path: '/work/app', rootId: 'r-local' },
      primaryRootId: 'r-local',
      secondaryRoots: [{ displayName: 'docs', path: '/work/docs', rootId: 'r-docs' }],
    });
  });

  it('rejects selecting a worktree when the current primary root cannot be resolved', async () => {
    const { result } = renderHook(() => useThreadCheckout(ARGS));
    await result.current.selectWorktree({
      branch: null,
      path: '/managed/app/bright-fox',
      worktreeId: 'w-1',
    });
    const derive = enqueue.mock.calls[0]?.[1];

    expect(() =>
      derive?.({
        checkoutLocalRootId: undefined,
        metadataPending: false,
        primaryRoot: undefined,
        primaryRootId: 'r-local',
        secondaryRootIds: [],
        secondaryRoots: [],
        threadId: 't-1',
      })
    ).toThrow('Could not switch worktrees: the current primary folder is no longer available.');
  });

  it('refuses to record the local root as the worktree itself on a degenerate re-select (BST-1390)', async () => {
    resolveRootIdForPath.mockResolvedValue('r-worktree');
    const { result } = renderHook(() => useThreadCheckout(ARGS));
    await result.current.selectWorktree({
      branch: null,
      path: '/managed/app/bright-fox',
      worktreeId: 'w-1',
    });
    const derive = enqueue.mock.calls[0]?.[1];

    expect(() =>
      derive?.({
        checkoutLocalRootId: undefined,
        metadataPending: false,
        primaryRoot: {
          displayName: 'bright-fox',
          path: '/managed/app/bright-fox',
          rootId: 'r-worktree',
        },
        primaryRootId: 'r-worktree',
        secondaryRootIds: [],
        secondaryRoots: [],
        threadId: 't-1',
      })
    ).toThrow(
      "You're already in this worktree and no Local folder is recorded — add a folder first."
    );
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      "You're already in this worktree and no Local folder is recorded — add a folder first.",
      {
        primaryRootId: 'r-worktree',
        worktreeId: 'w-1',
      }
    );
  });

  it('fails visibly when the worktree root never reconciled', async () => {
    resolveRootIdForPath.mockRejectedValue(new Error('no roots row'));
    const { result } = renderHook(() => useThreadCheckout(ARGS));
    await expect(
      result.current.selectWorktree({
        branch: null,
        path: '/managed/app/x',
        worktreeId: 'w-1',
      })
    ).rejects.toThrow('no roots row');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
