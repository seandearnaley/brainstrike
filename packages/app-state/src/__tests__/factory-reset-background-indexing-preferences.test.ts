import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPersistentUiState } from '../factory-reset';
import {
  __resetBackgroundIndexingPreferencesStoreForTests,
  useBackgroundIndexingPreferencesStore,
} from '../stores/background-indexing-preferences-store';

const globalWindow = window as Window &
  typeof globalThis & {
    caches?: CacheStorage;
  };

describe('factory reset wires the background indexing preferences store', () => {
  let originalCaches: CacheStorage | undefined;

  beforeEach(() => {
    __resetBackgroundIndexingPreferencesStoreForTests();
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
    __resetBackgroundIndexingPreferencesStoreForTests();
  });

  it('resets the live per-root indexing opt-in map during clearPersistentUiState', async () => {
    const store = useBackgroundIndexingPreferencesStore.getState();
    store.setWorktreeRootIndexingEnabled('root-a', true);
    expect(useBackgroundIndexingPreferencesStore.getState().worktreeRootIndexingOptInById).toEqual({
      'root-a': true,
    });

    await clearPersistentUiState({ skipIndexedDb: true });

    const state = useBackgroundIndexingPreferencesStore.getState();
    expect(state.worktreeRootIndexingOptInById).toEqual({});
  });
});
