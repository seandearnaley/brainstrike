import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPersistentUiState } from '../factory-reset';
import {
  __resetExperimentAssignmentPreferencesStoreForTests,
  useExperimentAssignmentPreferencesStore,
} from '../stores/experiment-assignment-preferences-store';

const globalWindow = window as Window &
  typeof globalThis & {
    caches?: CacheStorage;
  };

describe('factory reset wires the experiment assignment preferences store', () => {
  let originalCaches: CacheStorage | undefined;

  beforeEach(() => {
    __resetExperimentAssignmentPreferencesStoreForTests();
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
    __resetExperimentAssignmentPreferencesStoreForTests();
  });

  it('resets in-memory + persisted enrollment during clearPersistentUiState', async () => {
    const store = useExperimentAssignmentPreferencesStore.getState();
    store.setExperimentId('search-policy-v1');
    store.setVariant('control');

    await clearPersistentUiState({ skipIndexedDb: true });

    const state = useExperimentAssignmentPreferencesStore.getState();
    expect(state.experimentId).toBeNull();
    expect(state.variant).toBeNull();
  });
});
