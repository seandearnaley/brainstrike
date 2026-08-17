import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPersistentUiState } from '../factory-reset';
import {
  __resetSelfImprovementSignalPreferencesStoreForTests,
  useSelfImprovementSignalPreferencesStore,
} from '../stores/self-improvement-signal-preferences-store';

const globalWindow = window as Window &
  typeof globalThis & {
    caches?: CacheStorage;
  };

describe('factory reset wires the self-improvement signal preferences store', () => {
  let originalCaches: CacheStorage | undefined;

  beforeEach(() => {
    __resetSelfImprovementSignalPreferencesStoreForTests();
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
    __resetSelfImprovementSignalPreferencesStoreForTests();
  });

  it('resets in-memory + persisted preferences during clearPersistentUiState', async () => {
    useSelfImprovementSignalPreferencesStore.getState().setEnabled(true);

    await clearPersistentUiState({ skipIndexedDb: true });

    expect(useSelfImprovementSignalPreferencesStore.getState().enabled).toBe(false);
  });
});
