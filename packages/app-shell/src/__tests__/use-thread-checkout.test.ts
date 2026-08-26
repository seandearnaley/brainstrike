import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ThreadCheckoutFolders,
  type ThreadCheckoutWrite,
  useThreadCheckout,
} from '../hooks/use-thread-checkout';

const enqueue = vi.fn(
  async (
    _threadId: string | undefined,
    derive: (current: ThreadCheckoutFolders) => ThreadCheckoutWrite | null
  ) => {
    derive({
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
      ids: readonly string[];
      secondaryRoots: readonly { rootId: string }[];
    };
    const write = derive({
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
      ids: readonly string[];
    };
    const write = derive({
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
    expect(write.ids).toEqual([]);
  });

  it('reads the remembered Local root off the thread metadata', () => {
    const { result } = renderHook(() =>
      useThreadCheckout({
        ...ARGS,
        threadMetadata: {
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
      ids: [],
      primaryRoot: current.primaryRoot,
      primaryRootId: 'r-worktree',
      secondaryRoots: [],
    });
  });

  it('refuses hand-off when the remembered Local root has no complete roots row', async () => {
    const { result } = renderHook(() => useThreadCheckout(ARGS));
    await result.current.handOffToLocal();
    const derive = enqueue.mock.calls[0]?.[1];
    expect(
      derive?.({
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
    ).toBeNull();
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
