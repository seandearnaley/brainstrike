import { MemoryStorageAdapter } from '@brainstrike/storage';
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

async function createHydratedStore(storage: MemoryStorageAdapter) {
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
