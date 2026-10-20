import { createFileExplorerStore } from '@brainstrike/file-explorer';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import type { DirectoryHandle } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ExplorerCloseLifecycle } from '../shell/explorer-close-lifecycle';
import { useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import { RootDataDeletionProvider } from '../shell/root-data-deletion-context';
import { useFileSystemInstance } from '../shell/use-file-system-context';
import { FileExplorerTestWrapper, withProviderCloseOwner } from './test-helpers';

function originalCauses(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(originalCauses) : [error];
}

it.each([false, true])(
  'close joins an admitted delete through canonical root removal (reject=%s)',
  async (rejectDelete) => {
    const adapter = new MockFileSystemAdapter();
    const storage = new MemoryStorageAdapter();
    const deletion = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const failure = new Error('original root deletion failure');
    const deleteRootData = vi.fn(async () => {
      entered.resolve();
      await deletion.promise;
    });
    const producers = new Set<() => Promise<void>>();
    const persistence = new Map<() => Promise<void>, () => void>();
    let preparing = false;
    const lifecycle: ExplorerCloseLifecycle = withProviderCloseOwner({
      isPreparing: () => preparing,
      registerPersistence: (prepare, begin) => {
        persistence.set(prepare, begin);
        return () => {
          persistence.delete(prepare);
        };
      },
      registerProducer: (prepare) => {
        producers.add(prepare);
        return () => {
          producers.delete(prepare);
        };
      },
    });
    const view = renderHook(
      () => ({ fs: useFileSystemInstance(), store: useFileExplorerStoreContext() }),
      {
        wrapper: ({ children }) => (
          <FileExplorerTestWrapper
            closeLifecycle={lifecycle}
            mockFileSystemAdapter={adapter}
            mockStorageAdapter={storage}
          >
            <RootDataDeletionProvider deleteRootData={deleteRootData}>
              {children}
            </RootDataDeletionProvider>
          </FileExplorerTestWrapper>
        ),
      }
    );
    const handle: DirectoryHandle = {
      kind: 'directory',
      name: 'fixture',
      path: '/fixture',
      platform: 'web',
    };
    vi.spyOn(adapter, 'requestDirectoryAccess').mockResolvedValue(handle);
    await act(async () => {
      await view.result.current.fs.selectRootDirectory();
    });
    const rootId = view.result.current.store.getState().currentFolderId;
    if (!rootId) {
      throw new Error('Fixture root was not admitted');
    }
    expect(view.result.current.store.getState().activeRootIds).toContain(rootId);
    await view.result.current.store.drainPersistence();
    let removing!: Promise<void>;
    act(() => {
      removing = view.result.current.fs.removeRootDirectory(rootId, { deleteData: true });
    });
    await entered.promise;
    let closed = false;
    let closing!: Promise<unknown>;
    act(() => {
      preparing = true;
      for (const begin of persistence.values()) {
        begin();
      }
      closing = (async () => {
        const results = await Promise.allSettled([...producers].map((prepare) => prepare()));
        results.push(
          ...(await Promise.allSettled([...persistence.keys()].map((prepare) => prepare())))
        );
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        if (failures.length) {
          throw new AggregateError(failures, 'Root close preparation failed');
        }
      })().then(
        () => {
          closed = true;
        },
        (error: unknown) => {
          closed = true;
          return error;
        }
      );
    });
    try {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      expect(closed).toBe(false);
    } finally {
      await act(async () => {
        if (rejectDelete) {
          deletion.reject(failure);
        } else {
          deletion.resolve();
        }
        await removing;
      });
    }
    const outcome = await closing;
    const reopened = createFileExplorerStore(storage);
    await waitFor(() => expect(reopened.persist.hasHydrated()).toBe(true));
    if (rejectDelete) {
      expect(originalCauses(outcome)).toContain(failure);
      expect(reopened.getState().activeRootIds).toContain(rootId);
    } else {
      expect(outcome).toBeUndefined();
      expect(reopened.getState().activeRootIds.includes(rootId)).toBe(false);
      expect(reopened.getState().rootDescriptors[rootId]).toBeUndefined();
      expect(reopened.getState().currentFolderId).toBeNull();
      expect(view.result.current.fs.rootDirectoryHandles).toHaveLength(0);
    }
    view.unmount();
  }
);
