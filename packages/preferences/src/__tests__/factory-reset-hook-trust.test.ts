import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPersistentUiState } from '../settings/system/factory-reset-helpers';
import { __resetHookTrustStoreForTests, useHookTrustStore } from '../stores/hook-trust-store';

const globalWindow = window as Window &
  typeof globalThis & {
    caches?: CacheStorage;
  };

describe('factory reset wires the hook trust store', () => {
  let originalCaches: CacheStorage | undefined;

  beforeEach(() => {
    __resetHookTrustStoreForTests();
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
    __resetHookTrustStoreForTests();
  });

  it('drops every per-root approval during clearPersistentUiState', async () => {
    useHookTrustStore.getState().approveRoot('root-a', 'hash-a');
    useHookTrustStore.getState().approveRoot('root-b', 'hash-b');

    await clearPersistentUiState({ skipIndexedDb: true });

    expect(useHookTrustStore.getState().approvalsByRootId).toEqual({});
  });
});
