/**
 * BST-1990 PR 3: the workspace bar publishes the selected thread's folders for
 * the Files cards, and applies a card's "Add to this thread" request once,
 * through the bar's one add-secondary write.
 */
import { useThreadFolderScopeStore } from '@brainstrike/file-explorer-ui/thread-folder-scope-store';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  toast: toastSpy,
}));

import {
  type UseThreadFolderScopeArgs,
  useThreadFolderScope,
} from '../hooks/use-thread-folder-scope';

const SECONDARIES: readonly string[] = ['root-c'];

function args(overrides: Partial<UseThreadFolderScopeArgs> = {}): UseThreadFolderScopeArgs {
  return {
    bindingRootId: 'root-a',
    foldersPending: false,
    recordAddedAsSecondary: vi.fn(async () => undefined),
    secondaryRootIds: SECONDARIES,
    threadId: 'thread-1',
    ...overrides,
  };
}

const BRAVO = { displayName: 'bravo', path: '/ws/bravo', rootId: 'root-b' };

describe('useThreadFolderScope', () => {
  beforeEach(() => {
    useThreadFolderScopeStore.getState().reset();
    toastSpy.mockClear();
  });

  it("publishes the bound thread's folders", () => {
    renderHook(() => useThreadFolderScope(args()));
    expect(useThreadFolderScopeStore.getState().scope).toEqual({
      rootIds: ['root-a', 'root-c'],
      threadId: 'thread-1',
    });
  });

  it('publishes no scope while the thread has no binding, and clears it on unmount', () => {
    const { rerender, unmount } = renderHook(
      (props: UseThreadFolderScopeArgs) => useThreadFolderScope(props),
      { initialProps: args({ bindingRootId: undefined }) }
    );
    expect(useThreadFolderScopeStore.getState().scope).toBeNull();
    rerender(args());
    expect(useThreadFolderScopeStore.getState().scope).not.toBeNull();
    unmount();
    expect(useThreadFolderScopeStore.getState().scope).toBeNull();
  });

  it("applies a card's request once, through the add-secondary write", async () => {
    const recordAddedAsSecondary = vi.fn(async () => undefined);
    const { rerender } = renderHook(
      (props: UseThreadFolderScopeArgs) => useThreadFolderScope(props),
      { initialProps: args({ recordAddedAsSecondary }) }
    );
    act(() => {
      useThreadFolderScopeStore.getState().requestAdd(BRAVO);
    });
    await waitFor(() => expect(recordAddedAsSecondary).toHaveBeenCalledTimes(1));
    expect(recordAddedAsSecondary).toHaveBeenCalledWith({ name: 'bravo', path: '/ws/bravo' });
    expect(useThreadFolderScopeStore.getState().pendingAdd).toBeNull();
    rerender(args({ recordAddedAsSecondary }));
    expect(recordAddedAsSecondary).toHaveBeenCalledTimes(1);
  });

  it("waits for the thread's folders before applying a request", async () => {
    const recordAddedAsSecondary = vi.fn(async () => undefined);
    const { rerender } = renderHook(
      (props: UseThreadFolderScopeArgs) => useThreadFolderScope(props),
      {
        initialProps: args({ foldersPending: true, recordAddedAsSecondary }),
      }
    );
    act(() => {
      useThreadFolderScopeStore.getState().requestAdd(BRAVO);
    });
    expect(recordAddedAsSecondary).not.toHaveBeenCalled();
    rerender(args({ recordAddedAsSecondary }));
    await waitFor(() => expect(recordAddedAsSecondary).toHaveBeenCalledTimes(1));
  });

  it('says so when the write fails', async () => {
    const recordAddedAsSecondary = vi.fn(async () => {
      throw new Error('Cannot record a thread folder before the workspace database is ready.');
    });
    renderHook(() => useThreadFolderScope(args({ recordAddedAsSecondary })));
    act(() => {
      useThreadFolderScopeStore.getState().requestAdd(BRAVO);
    });
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Cannot record a thread folder before the workspace database is ready.',
          variant: 'destructive',
        })
      )
    );
  });
});
