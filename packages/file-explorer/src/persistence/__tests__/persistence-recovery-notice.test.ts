import { MemoryStorageAdapter, type StorageAdapter } from '@brainstrike/storage';
import { describe, expect, it, vi } from 'vitest';
import { createFileExplorerStore } from '../../store';
import { FILE_EXPLORER_STORAGE_KEY, FILE_EXPLORER_STORAGE_VERSION } from '../persistence-constants';

const validSerializedState = {
  currentFolderId: null,
  expandedDirectoryPaths: [],
  folderAccessOrder: [],
  folderStates: {},
  quickFilter: 'restored-filter',
  selectedFilePaths: [],
};

async function createHydratedStore(storage: StorageAdapter) {
  const store = createFileExplorerStore(storage);
  await vi.waitFor(() => expect(store.persist.hasHydrated()).toBe(true));
  return store;
}

async function seedPersistedState(
  storage: MemoryStorageAdapter,
  state: unknown,
  version: number = FILE_EXPLORER_STORAGE_VERSION
): Promise<void> {
  await storage.setItem(
    FILE_EXPLORER_STORAGE_KEY,
    JSON.stringify({
      state,
      version,
    })
  );
}

describe('persisted explorer recovery notice', () => {
  it('surfaces an unavailable read without overwriting the valid snapshot', async () => {
    const backingStorage = new MemoryStorageAdapter();
    await seedPersistedState(backingStorage, validSerializedState);
    const originalSnapshot = await backingStorage.getItem(FILE_EXPLORER_STORAGE_KEY);
    let remainingReadFailures = 6;
    const setItem = vi.fn(async (key: string, value: string) => {
      await backingStorage.setItem(key, value);
    });
    const unavailableStorage = {
      clear: () => backingStorage.clear(),
      getAllKeys: () => backingStorage.getAllKeys(),
      getItem: async (key: string) => {
        if (remainingReadFailures > 0) {
          remainingReadFailures -= 1;
          throw new Error('Storage temporarily unavailable');
        }
        return await backingStorage.getItem(key);
      },
      removeItem: (key: string) => backingStorage.removeItem(key),
      setItem,
    };

    const store = createFileExplorerStore(unavailableStorage);
    await vi.waitFor(() =>
      expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-unavailable')
    );
    await vi.waitFor(() => expect(remainingReadFailures).toBe(2));

    expect(store.persist.hasHydrated()).toBe(true);
    expect(setItem).not.toHaveBeenCalled();
    expect(await backingStorage.getItem(FILE_EXPLORER_STORAGE_KEY)).toBe(originalSnapshot);

    expect(store.getState().consumePersistenceRecoveryNotice()).toBe(true);
    await vi.waitFor(() => expect(remainingReadFailures).toBe(0));
    await vi.waitFor(() => expect(setItem).not.toHaveBeenCalled());
    expect(await backingStorage.getItem(FILE_EXPLORER_STORAGE_KEY)).toBe(originalSnapshot);

    store.getState().setQuickFilter('intentional-change');
    await vi.waitFor(() => expect(setItem).toHaveBeenCalledOnce());
    expect(await backingStorage.getItem(FILE_EXPLORER_STORAGE_KEY)).not.toBe(originalSnapshot);
  });

  it('retries one transient read and hydrates the original snapshot', async () => {
    const backingStorage = new MemoryStorageAdapter();
    await seedPersistedState(backingStorage, validSerializedState);
    let getItemCalls = 0;
    const transientStorage = {
      clear: () => backingStorage.clear(),
      getAllKeys: () => backingStorage.getAllKeys(),
      getItem: async (key: string) => {
        getItemCalls += 1;
        if (getItemCalls === 1) {
          throw new Error('Storage temporarily unavailable');
        }
        return await backingStorage.getItem(key);
      },
      removeItem: (key: string) => backingStorage.removeItem(key),
      setItem: (key: string, value: string) => backingStorage.setItem(key, value),
    };

    const store = await createHydratedStore(transientStorage);

    expect(getItemCalls).toBe(2);
    expect(store.getState().quickFilter).toBe('restored-filter');
    expect(store.getState().persistenceRecoveryNotice).toBeNull();
  });

  it('recovers a corrupt-shaped payload to empty state and records one discard notice', async () => {
    const storage = new MemoryStorageAdapter();
    await seedPersistedState(storage, {
      filePath: '/Users/alice/secret-client/source.ts',
      folderStates: 'corrupt',
    });

    const store = await createHydratedStore(storage);

    expect(store.getState().currentFolderId).toBeNull();
    expect(store.getState().selectedFilePaths).toEqual(new Set());
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
    expect(store.getState().consumePersistenceRecoveryNotice()).toBe(true);
    expect(store.getState().consumePersistenceRecoveryNotice()).toBe(false);
    expect(store.getState().persistenceRecoveryNotice).toBeNull();
  });

  it('recovers a corrupt nested folder snapshot instead of throwing during merge', async () => {
    const storage = new MemoryStorageAdapter();
    await seedPersistedState(storage, {
      ...validSerializedState,
      currentFolderId: '/Users/alice/secret-client-project',
      folderStates: {
        '/Users/alice/secret-client-project': null,
      },
    });

    const store = await createHydratedStore(storage);

    expect(store.getState().currentFolderId).toBeNull();
    expect(store.getState().folderStates).toEqual({});
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('salvages valid folders when one top-level container is malformed', async () => {
    const storage = new MemoryStorageAdapter();
    await seedPersistedState(storage, {
      ...validSerializedState,
      currentFolderId: 'valid',
      folderAccessOrder: null,
      folderStates: {
        valid: { selectedFilePaths: ['valid|@|src/valid.ts'] },
      },
    });

    const store = await createHydratedStore(storage);

    expect(store.getState().currentFolderId).toBe('valid');
    expect(store.getState().folderStates['valid']?.selectedFilePaths).toEqual(
      new Set(['valid|@|src/valid.ts'])
    );
    expect(store.getState().folderAccessOrder).toEqual([]);
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('clears a dangling current folder when the folder-state container is malformed', async () => {
    const storage = new MemoryStorageAdapter();
    await seedPersistedState(storage, {
      ...validSerializedState,
      currentFolderId: 'dangling-folder',
      folderStates: null,
    });

    const store = await createHydratedStore(storage);

    expect(store.getState().currentFolderId).toBeNull();
    expect(store.getState().folderStates).toEqual({});
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('removes folder references absent from a valid folder-state map', async () => {
    const storage = new MemoryStorageAdapter();
    await seedPersistedState(storage, {
      ...validSerializedState,
      currentFolderId: 'dangling-folder',
      folderAccessOrder: ['dangling-folder', 'valid'],
      folderStates: {
        valid: { selectedFilePaths: ['valid|@|src/valid.ts'] },
      },
    });

    const store = await createHydratedStore(storage);

    expect(store.getState().currentFolderId).toBeNull();
    expect(store.getState().folderAccessOrder).toEqual(['valid']);
    expect(store.getState().folderStates['valid']?.selectedFilePaths).toEqual(
      new Set(['valid|@|src/valid.ts'])
    );
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('recovers an unsupported-version payload to empty state and records a discard notice', async () => {
    const storage = new MemoryStorageAdapter();
    await seedPersistedState(
      storage,
      {
        ...validSerializedState,
        currentFolderId: '/Users/alice/future-client-project',
      },
      FILE_EXPLORER_STORAGE_VERSION + 1
    );

    const store = await createHydratedStore(storage);

    expect(store.getState().currentFolderId).toBeNull();
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('silently resets a deliberately unsupported older version', async () => {
    const storage = new MemoryStorageAdapter();
    await seedPersistedState(storage, validSerializedState, FILE_EXPLORER_STORAGE_VERSION - 1);

    const store = await createHydratedStore(storage);

    expect(store.getState().quickFilter).not.toBe('restored-filter');
    expect(store.getState().persistenceRecoveryNotice).toBeNull();
  });

  it('rejects a nonnumeric envelope version', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.setItem(
      FILE_EXPLORER_STORAGE_KEY,
      JSON.stringify({ state: validSerializedState, version: '999' })
    );

    const store = await createHydratedStore(storage);

    expect(store.getState().quickFilter).not.toBe('restored-filter');
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('hydrates a bare current serialized state through the compatibility path', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.setItem(FILE_EXPLORER_STORAGE_KEY, JSON.stringify(validSerializedState));

    const store = await createHydratedStore(storage);

    expect(store.getState().quickFilter).toBe('restored-filter');
    expect(store.getState().persistenceRecoveryNotice).toBeNull();
  });

  it('rejects a null envelope state consistently', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.setItem(
      FILE_EXPLORER_STORAGE_KEY,
      JSON.stringify({ state: null, version: FILE_EXPLORER_STORAGE_VERSION })
    );

    const store = await createHydratedStore(storage);

    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('records a discard notice when invalid JSON is removed during recovery', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.setItem(
      FILE_EXPLORER_STORAGE_KEY,
      '{"filePath":"/Users/alice/secret-client/source.ts"'
    );

    const store = await createHydratedStore(storage);

    expect(await storage.getItem(FILE_EXPLORER_STORAGE_KEY)).not.toContain('secret-client');
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('records a discard notice when a malformed persist envelope is removed', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.setItem(
      FILE_EXPLORER_STORAGE_KEY,
      JSON.stringify({ version: FILE_EXPLORER_STORAGE_VERSION })
    );

    const store = await createHydratedStore(storage);

    const recoveredRawValue = await storage.getItem(FILE_EXPLORER_STORAGE_KEY);
    const recoveredEnvelope = JSON.parse(recoveredRawValue ?? 'null') as {
      state?: unknown;
      version?: number;
    } | null;
    expect(recoveredEnvelope).toMatchObject({
      state: expect.any(Object),
      version: FILE_EXPLORER_STORAGE_VERSION,
    });
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('reports malformed nested folder selection containers while preserving valid folders', async () => {
    const storage = new MemoryStorageAdapter();
    await seedPersistedState(storage, {
      ...validSerializedState,
      folderStates: {
        malformed: { selectedFilePaths: 'not-an-array' },
        valid: { selectedFilePaths: ['valid|@|src/valid.ts'] },
      },
    });

    const store = await createHydratedStore(storage);

    expect(store.getState().folderStates['malformed']).toBeUndefined();
    expect(store.getState().folderStates['valid']?.selectedFilePaths).toEqual(
      new Set(['valid|@|src/valid.ts'])
    );
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('salvages canonical entries from top-level persisted arrays and reports corruption', async () => {
    const storage = new MemoryStorageAdapter();
    await seedPersistedState(storage, {
      ...validSerializedState,
      selectedFilePaths: ['root-1|@|src/index.ts', null],
    });

    const store = await createHydratedStore(storage);

    expect(store.getState().selectedFilePaths).toEqual(new Set(['root-1|@|src/index.ts']));
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('drops malformed persisted selection keys and records a visible discard notice', async () => {
    const storage = new MemoryStorageAdapter();
    await seedPersistedState(storage, {
      ...validSerializedState,
      selectedFilePaths: [
        'root-1|@|src/index.ts',
        'persisted-path-without-prefix',
        '|@|src/missing-root.ts',
        'root-1|@|',
      ],
    });

    const store = await createHydratedStore(storage);

    expect(store.getState().selectedFilePaths).toEqual(new Set(['root-1|@|src/index.ts']));
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('does not record a discard notice when no persisted state exists', async () => {
    const store = await createHydratedStore(new MemoryStorageAdapter());

    expect(store.getState().persistenceRecoveryNotice).toBeNull();
  });

  it('reports same-version state with an invalid current folder identifier', async () => {
    const storage = new MemoryStorageAdapter();
    await seedPersistedState(storage, {
      ...validSerializedState,
      currentFolderId: { rawPath: '/Users/alice/secret-client-project' },
    });

    const store = await createHydratedStore(storage);

    expect(store.getState().currentFolderId).toBeNull();
    expect(store.getState().persistenceRecoveryNotice).toBe('persisted-state-discarded');
  });

  it('hydrates valid state without recording a discard notice', async () => {
    const storage = new MemoryStorageAdapter();
    await seedPersistedState(storage, validSerializedState);

    const store = await createHydratedStore(storage);

    expect(store.getState().quickFilter).toBe('restored-filter');
    expect(store.getState().persistenceRecoveryNotice).toBeNull();
  });

  it('never hydrates a persisted recovery notice into ephemeral state', async () => {
    const storage = new MemoryStorageAdapter();
    await seedPersistedState(storage, {
      ...validSerializedState,
      persistenceRecoveryNotice: 'persisted-state-discarded',
    });

    const store = await createHydratedStore(storage);

    expect(store.getState().quickFilter).toBe('restored-filter');
    expect(store.getState().persistenceRecoveryNotice).toBeNull();
  });
});
