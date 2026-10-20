import { createFileExplorerStore } from '@brainstrike/file-explorer';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import type { RootDescriptor } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useFileSystem } from '../use-file-system';
import { createAdaptersTestWrapper } from './test-helpers';

it('an admitted root restore must settle before its Explorer persistence retires', async () => {
  const restored = Promise.withResolvers<RootDescriptor[]>();
  const storage = new MemoryStorageAdapter();
  const store = createFileExplorerStore(storage);
  const state = store.getState();
  const adapter: FileSystemAdapter = {
    exists: vi.fn().mockResolvedValue(true),
    readDirectory: vi.fn().mockResolvedValue([]),
    readFile: vi.fn(),
    requestDirectoryAccess: vi.fn(),
    restoreRoots: vi.fn(() => restored.promise),
  };
  const producers = new Set<() => Promise<void>>();
  let preparing = false;
  const parameters: Parameters<typeof useFileSystem>[0] = {
    addActiveRoot: state.addActiveRoot,
    closeLifecycle: {
      isPreparing: () => preparing,
      registerProducer: (prepare) => {
        producers.add(prepare);
        return () => {
          producers.delete(prepare);
        };
      },
    },
    getFolderAccessOrder: () => store.getState().folderAccessOrder,
    getPersistedCurrentFolderId: () => store.getState().currentFolderId,
    removeActiveRoot: state.removeActiveRoot,
    setActiveRoots: state.setActiveRoots,
    setCurrentFolderId: state.setCurrentFolderId,
  };
  const { result } = renderHook(() => useFileSystem(parameters), {
    wrapper: createAdaptersTestWrapper(adapter, storage),
  });
  await waitFor(() => expect(adapter.restoreRoots).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(store.persist.hasHydrated()).toBe(true));
  // The real root restore was accepted while this store was live.
  preparing = true;
  let closed = false;
  const closing = Promise.all([...producers].map((prepare) => prepare()))
    .then(() => store.preparePersistenceClose())
    .then(() => {
      closed = true;
    });
  expect(closed).toBe(false);
  await expect(result.current.addRootDirectory()).rejects.toThrow('preparing to close');
  const persisted = store.persist.getOptions().storage!;
  const results: PromiseSettledResult<unknown>[] = [];
  store.persist.setOptions({
    storage: {
      ...persisted,
      setItem: (name, value) => {
        const completion = persisted.setItem(name, value);
        // Observe deliberate negative results, preserving the returned Promise.
        void Promise.resolve(completion).then(
          (value) => results.push({ status: 'fulfilled', value }),
          (reason: unknown) => results.push({ reason, status: 'rejected' })
        );
        return completion;
      },
    },
  });
  await act(async () => {
    restored.resolve([
      {
        displayName: 'fixture',
        handle: { kind: 'directory', name: 'fixture', path: '/work/fixture', platform: 'electron' },
        kind: 'path',
        permissionState: 'granted',
        persisted: true,
        rootId: 'root-fixture',
      },
    ]);
    await restored.promise;
  });
  await waitFor(() => expect(result.current.rootDirectoryHandles).toHaveLength(1));
  await closing;
  expect(closed).toBe(true);
  expect(store.getState().activeRootIds).toEqual(['root-fixture']);
  expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(0);
});
