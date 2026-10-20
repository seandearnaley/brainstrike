import { clearPersistentUiStateWithResult } from '@brainstrike/app-state/factory-reset';
import * as fileExplorer from '@brainstrike/file-explorer';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useFileContentLoadAuthority } from '../file-content-load-authority-context';
import {
  FileExplorerProvider,
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
  useOptionalFileExplorerStoreSelector,
} from '../shell/file-explorer-provider';

// Utility wrapper for provider
function wrapper(storage: MemoryStorageAdapter) {
  return ({ children }: { children: ReactNode }) => (
    <FileExplorerProvider storageAdapter={storage}>{children}</FileExplorerProvider>
  );
}

describe('FileExplorerProvider', () => {
  it('retains a write failure while another close producer is still draining', async () => {
    const storage = new MemoryStorageAdapter();
    const ack = Promise.withResolvers<void>();
    const producer = Promise.withResolvers<void>();
    const failure = new Error('original adapter failure during producer drain');
    const { result } = renderHook(() => useFileExplorerStoreContext(), {
      wrapper: wrapper(storage),
    });
    await waitFor(() => expect(result.current.persist.hasHydrated()).toBe(true));
    vi.spyOn(storage, 'setItem').mockImplementation(() => ack.promise);
    const options = result.current.persist.getOptions();
    if (!(options.name && options.storage && options.partialize)) {
      throw new Error('Expected configured Explorer persistence');
    }
    const saving = Promise.resolve(
      options.storage.setItem(options.name, {
        state: options.partialize(result.current.getState()),
        version: options.version ?? 0,
      })
    );
    const observedSave = saving.catch((error: unknown) => error);
    // This models the persistence participant's observation callback at close entry,
    // before the separate producer phase is allowed to finish.
    const begin = (
      result.current as typeof result.current & {
        beginPersistenceClose?: () => void;
      }
    ).beginPersistenceClose;
    begin?.();
    const closing = (async () => {
      await producer.promise;
      await result.current.preparePersistenceClose();
    })();
    ack.reject(failure);
    expect(await observedSave).toBe(failure);
    producer.resolve();
    await expect(closing).rejects.toBe(failure);
  });

  it('StrictMode cleanup retains pending persistence without fencing the live provider', async () => {
    const ack = Promise.withResolvers<void>();
    const storage = new MemoryStorageAdapter();
    const write = storage.setItem.bind(storage);
    vi.spyOn(storage, 'setItem').mockImplementation(async (name, value) => {
      await ack.promise;
      await write(name, value);
    });
    const participants = new Set<() => Promise<void>>();
    const register = (prepare: () => Promise<void>) => {
      participants.add(prepare);
      return () => {
        participants.delete(prepare);
      };
    };
    const { result, unmount } = renderHook(() => useFileExplorerStoreContext(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <StrictMode>
          <FileExplorerProvider
            closeLifecycle={{
              isPreparing: () => false,
              registerPersistence: register,
              registerProducer: () => () => {},
            }}
            storageAdapter={storage}
          >
            {children}
          </FileExplorerProvider>
        </StrictMode>
      ),
    });
    await waitFor(() => expect(participants.size).toBe(1));
    act(() => {
      result.current.setState({ quickFilter: 'kept' });
    });
    await waitFor(() => expect(storage.setItem).toHaveBeenCalled());
    unmount();
    expect(participants.size).toBe(1);
    let closed = false;
    const closing = Promise.all([...participants].map((prepare) => prepare())).then(() => {
      closed = true;
    });
    expect(closed).toBe(false);
    ack.resolve();
    await closing;
    await waitFor(() => expect(participants.size).toBe(0));
  });

  it('throws when useFileExplorerStoreContext is used outside the provider', () => {
    expect(() => {
      renderHook(() => useFileExplorerStoreContext());
    }).toThrow('useFileExplorerStoreContext must be used within a FileExplorerProvider');
  });

  it('provides store instance with the supplied storage adapter', () => {
    const storage = new MemoryStorageAdapter();

    // Create a dummy store using the real factory so it matches expected type
    const dummyStore = fileExplorer.createFileExplorerStore(new MemoryStorageAdapter());
    const spy = vi.spyOn(fileExplorer, 'createFileExplorerStore').mockReturnValue(dummyStore);

    const { result } = renderHook(() => useFileExplorerStoreContext(), {
      wrapper: wrapper(storage),
    });

    expect(spy).toHaveBeenCalledWith(storage);
    expect(result.current).toBe(dummyStore);

    spy.mockRestore();
  });

  it('selects live store state inside the provider', () => {
    const storage = new MemoryStorageAdapter();

    const { result } = renderHook(
      () => {
        const store = useFileExplorerStoreContext();
        const currentFolderId = useFileExplorerStoreSelector((state) => state.currentFolderId);
        return { currentFolderId, store };
      },
      { wrapper: wrapper(storage) }
    );

    expect(result.current.currentFolderId).toBeNull();

    act(() => {
      result.current.store.setState({
        currentFolderId: 'folder-1',
      } as Partial<ReturnType<typeof result.current.store.getState>>);
    });

    expect(result.current.currentFolderId).toBe('folder-1');
  });

  it('returns the fallback selector value outside the provider', () => {
    const { result, rerender } = renderHook(
      ({ fallbackValue }: { fallbackValue: string }) =>
        useOptionalFileExplorerStoreSelector(() => 'live-value', fallbackValue),
      {
        initialProps: { fallbackValue: 'fallback-a' },
      }
    );

    expect(result.current).toBe('fallback-a');

    rerender({ fallbackValue: 'fallback-b' });
    expect(result.current).toBe('fallback-b');
  });

  it('reuses the previous selection when the equality function reports no change', () => {
    const storage = new MemoryStorageAdapter();

    const { result } = renderHook(
      () => {
        const store = useFileExplorerStoreContext();
        const selection = useOptionalFileExplorerStoreSelector(
          (state) => ({ currentFolderId: state.currentFolderId }),
          { currentFolderId: 'fallback' },
          (left, right) => left.currentFolderId === right.currentFolderId
        );
        return { selection, store };
      },
      { wrapper: wrapper(storage) }
    );

    const initialSelection = result.current.selection;
    expect(initialSelection.currentFolderId).toBeNull();

    act(() => {
      result.current.store.setState({
        expandedDirectoryPaths: new Set(['folder-1']),
      } as Partial<ReturnType<typeof result.current.store.getState>>);
    });

    expect(result.current.selection).toBe(initialSelection);
  });

  it('clears live file selections when factory reset drains session stores', async () => {
    // Search bridge selects containing files alongside chunks. Clearing only
    // the chunk store would leave whole-file selections after reset.
    const storage = new MemoryStorageAdapter();
    const { result } = renderHook(() => useFileExplorerStoreContext(), {
      wrapper: wrapper(storage),
    });

    act(() => {
      result.current.getState().setFolderSelection('root-a', ['root-a|@|src/a.ts']);
      result.current.getState().setSelectedFiles(new Set(['root-a|@|src/a.ts']));
      result.current.getState().setFileContent('root-a|@|src/a.ts', 'cached before reset');
    });
    expect(result.current.getState().selectedFilePaths.size).toBe(1);
    expect(result.current.getState().folderStates['root-a']?.selectedFilePaths.size).toBe(1);
    expect(result.current.getState().getFileContentCacheStats().entryCount).toBe(1);

    let resetResult: Awaited<ReturnType<typeof clearPersistentUiStateWithResult>> | undefined;
    await act(async () => {
      resetResult = await clearPersistentUiStateWithResult({ skipIndexedDb: true });
    });
    expect(resetResult?.success).toBe(true);
    expect(result.current.getState().selectedFilePaths.size).toBe(0);
    expect(result.current.getState().folderStates['root-a']?.selectedFilePaths.size).toBe(0);
    expect(result.current.getState().fileContents).toEqual({});
    expect(result.current.getState().getFileContentCacheStats().entryCount).toBe(0);
  });
  it.each(['ack', 'failure'] as const)(
    'terminal content preparation joins physical %s after logical invalidation',
    async (outcome) => {
      const physical = Promise.withResolvers<void>();
      const failure = new Error('controlled physical read failure');
      const storage = new MemoryStorageAdapter();
      const producers = new Set<() => Promise<void>>();
      let preparing = false;
      const lifecycle = {
        isPreparing: () => preparing,
        registerPersistence: () => () => {},
        registerProducer: (prepare: () => Promise<void>) => {
          producers.add(prepare);
          return () => {
            producers.delete(prepare);
          };
        },
      };
      const { result, unmount } = renderHook(() => useFileContentLoadAuthority(), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <FileExplorerProvider closeLifecycle={lifecycle} storageAdapter={storage}>
            {children}
          </FileExplorerProvider>
        ),
      });
      const ticket = result.current.scheduleBatch(
        ['root|@|file'],
        () => physical.promise,
        'interactive'
      );
      result.current.invalidateAll();
      await ticket; // Logical cancellation is deliberately already complete.
      unmount();
      expect(producers.size).toBe(1);
      preparing = true;
      let settled = false;
      const closing = Promise.all([...producers].map((prepare) => prepare())).then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          return error;
        }
      );
      await expect(
        result.current.scheduleBatch(['root|@|late'], async () => {}, 'interactive')
      ).rejects.toThrow('preparing to close');
      expect(settled).toBe(false);
      if (outcome === 'failure') {
        physical.reject(failure);
      } else {
        physical.resolve();
      }
      expect(await closing).toBe(outcome === 'failure' ? failure : undefined);
      expect(settled).toBe(true);
    }
  );
});
