import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPersistentUiState } from '../factory-reset.ts';
import {
  __resetWorkspaceInstructionsPreferencesStoreForTests,
  useWorkspaceInstructionsPreferencesStore,
} from '../stores/workspace-instructions-preferences-store.ts';

const globalWindow = window as Window &
  typeof globalThis & {
    caches?: CacheStorage;
  };

describe('factory reset wires the workspace instructions preferences store', () => {
  let originalCaches: CacheStorage | undefined;

  beforeEach(() => {
    __resetWorkspaceInstructionsPreferencesStoreForTests();
    originalCaches = globalWindow.caches;
    Object.defineProperty(globalWindow, 'caches', {
      configurable: true,
      value: {
        delete: async () => true,
        keys: async () => [] as string[],
      } as unknown as CacheStorage,
    });
  });

  afterEach(() => {
    if (originalCaches) {
      Object.defineProperty(globalWindow, 'caches', { configurable: true, value: originalCaches });
    } else {
      Reflect.deleteProperty(globalWindow, 'caches');
    }
    __resetWorkspaceInstructionsPreferencesStoreForTests();
  });

  it('resets in-memory + persisted preferences during clearPersistentUiState', async () => {
    const store = useWorkspaceInstructionsPreferencesStore.getState();
    store.setMasterEnabled(false);
    store.setOversizedOptIn('root-a', true);

    await clearPersistentUiState({ skipIndexedDb: true });

    const state = useWorkspaceInstructionsPreferencesStore.getState();
    expect(state.masterEnabled).toBe(true);
    expect(state.oversizedOptInByRootId).toEqual({});
  });
});
