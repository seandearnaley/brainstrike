import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPersistentUiState } from '../settings/system/factory-reset-helpers';
import {
  __resetNotificationPreferencesStoreForTests,
  useNotificationPreferencesStore,
} from '../stores/notification-preferences-store';

const globalWindow = window as Window &
  typeof globalThis & {
    caches?: CacheStorage;
  };

describe('factory reset wires the notification preferences store', () => {
  let originalCaches: CacheStorage | undefined;

  beforeEach(() => {
    __resetNotificationPreferencesStoreForTests();
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
    __resetNotificationPreferencesStoreForTests();
  });

  it('resets in-memory + persisted preferences during clearPersistentUiState', async () => {
    const store = useNotificationPreferencesStore.getState();
    store.setMasterEnabled(true);
    store.setEventEnabled('runFailed', false);

    await clearPersistentUiState({ skipIndexedDb: true });

    const state = useNotificationPreferencesStore.getState();
    expect(state.masterEnabled).toBe(false);
    expect(state.events).toEqual({
      runFailed: true,
      runFinished: true,
      toolApprovalRequired: true,
    });
  });
});
