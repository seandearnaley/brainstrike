import { createFileExplorerStore } from '@brainstrike/file-explorer';
// @vitest-environment node
import type { StorageAdapter } from '@brainstrike/storage';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import type { SerializedState } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import { persistFileExplorerStateImmediately } from '../utils/persist-file-explorer-state';

const createStorageAdapter = (): StorageAdapter => ({
  clear: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  getAllKeys: vi.fn<() => Promise<string[]>>(() => Promise.resolve([])),
  getItem: vi.fn<(_: string) => Promise<string | null>>(() => Promise.resolve(null)),
  removeItem: vi.fn<(_: string) => Promise<void>>(() => Promise.resolve()),
  setItem: vi.fn<(_: string, value: string) => Promise<void>>(() => Promise.resolve()),
});

const createSerializedState = (overrides: Partial<SerializedState> = {}): SerializedState => ({
  currentFolderId: null,
  devInlineFixtureEnabled: false,
  excludeFilters: [],
  expandedDirectoryPaths: [],
  folderAccessOrder: [],
  folderStates: {},
  folderSummaryThreshold: 100,
  includeFilters: [],
  includeProjectTree: true,
  lastActiveTab: 'preview',
  maxSelectionCount: 500,
  quickFilter: '',
  selectedFilePaths: [],
  useRegex: false,
  ...overrides,
});

async function hydratedStore(adapter: StorageAdapter) {
  const store = createFileExplorerStore(adapter);
  await vi.waitFor(() => expect(store.persist.hasHydrated()).toBe(true));
  return store;
}

describe('persistFileExplorerStateImmediately', () => {
  it('close owns an admitted immediate save through the same original adapter ACK', async () => {
    const adapter = new MemoryStorageAdapter();
    const store = await hydratedStore(adapter);
    const ack = Promise.withResolvers<void>();
    const admitted = Promise.withResolvers<void>();
    const original = adapter.setItem.bind(adapter);
    vi.spyOn(adapter, 'setItem').mockImplementation(async (key, value) => {
      admitted.resolve();
      await ack.promise;
      await original(key, value);
    });
    const saving = persistFileExplorerStateImmediately(store);
    await admitted.promise;
    let closed = false;
    const closing = store.preparePersistenceClose().then(() => {
      closed = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
    } finally {
      ack.resolve();
      await Promise.all([saving, closing]);
    }
    expect(adapter.setItem).toHaveBeenCalledOnce();
  });

  it('uses the configured partializer, storage key and version through the original adapter', async () => {
    const adapter = createStorageAdapter();
    const store = await hydratedStore(adapter);
    store.persist.setOptions({
      name: 'file-explorer',
      partialize: () => createSerializedState({ selectedFilePaths: ['/root/a.ts'] }),
      version: 7,
    });
    await persistFileExplorerStateImmediately(store);
    expect(adapter.setItem).toHaveBeenCalledExactlyOnceWith(
      'file-explorer',
      JSON.stringify({
        state: createSerializedState({ selectedFilePaths: ['/root/a.ts'] }),
        version: 7,
      })
    );
  });

  it('refuses immediate persistence before hydration without overwriting stored state', async () => {
    const adapter = createStorageAdapter();
    const read = Promise.withResolvers<string | null>();
    vi.mocked(adapter.getItem).mockReturnValue(read.promise);
    const store = createFileExplorerStore(adapter);
    try {
      await expect(persistFileExplorerStateImmediately(store)).rejects.toThrow(
        'before rehydration'
      );
      expect(adapter.setItem).not.toHaveBeenCalled();
    } finally {
      read.resolve(null);
      await vi.waitFor(() => expect(store.persist.hasHydrated()).toBe(true));
    }
  });

  it('refuses a missing persistence key', async () => {
    const adapter = createStorageAdapter();
    const store = await hydratedStore(adapter);
    store.persist.setOptions({ name: '' });
    await expect(persistFileExplorerStateImmediately(store)).rejects.toThrow(
      'persistence key is missing'
    );
    expect(adapter.setItem).not.toHaveBeenCalled();
  });

  it('preserves the original adapter failure for both immediate caller and close', async () => {
    const adapter = createStorageAdapter();
    const store = await hydratedStore(adapter);
    const ack = Promise.withResolvers<void>();
    const admitted = Promise.withResolvers<void>();
    const failure = new Error('original immediate save failure');
    vi.mocked(adapter.setItem).mockImplementation(() => {
      admitted.resolve();
      return ack.promise;
    });
    const saving = persistFileExplorerStateImmediately(store);
    const savedFailure = expect(saving).rejects.toBe(failure);
    await admitted.promise;
    const closedFailure = expect(store.preparePersistenceClose()).rejects.toBe(failure);
    ack.reject(failure);
    await Promise.all([savedFailure, closedFailure]);
  });
});
