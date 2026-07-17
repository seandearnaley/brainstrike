import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPersistentUiState } from '../settings/system/factory-reset-helpers';
import {
  __resetAssistantBudgetPreferencesStoreForTests,
  useAssistantBudgetPreferencesStore,
} from '../stores/assistant-budget-preferences-store';

const globalWindow = window as Window &
  typeof globalThis & {
    caches?: CacheStorage;
  };

describe('factory reset wires the assistant budget preferences store', () => {
  let originalCaches: CacheStorage | undefined;

  beforeEach(() => {
    __resetAssistantBudgetPreferencesStoreForTests();
    originalCaches = globalWindow.caches;
    // An empty CacheStorage keeps clearPersistentUiState from throwing on the
    // cache-verification path; this test only cares about the store reset.
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
    __resetAssistantBudgetPreferencesStoreForTests();
  });

  it('resets in-memory + persisted budget caps during clearPersistentUiState', async () => {
    const store = useAssistantBudgetPreferencesStore.getState();
    store.setDailyCapUsd(25);
    store.setPerRunCapUsd(2);

    await clearPersistentUiState({ skipIndexedDb: true });

    const state = useAssistantBudgetPreferencesStore.getState();
    expect(state.dailyCapUsd).toBeNull();
    expect(state.perRunCapUsd).toBeNull();
  });
});
