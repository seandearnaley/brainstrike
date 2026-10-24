import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPersistentUiState } from '../factory-reset.ts';
import {
  __resetDiagnosticsRetentionStoreForTests,
  useDiagnosticsRetentionStore,
} from '../stores/diagnostics-retention-store.ts';

const globalWindow = window as Window &
  typeof globalThis & {
    caches?: CacheStorage;
  };

describe('factory reset wires the diagnostics retention store', () => {
  let originalCaches: CacheStorage | undefined;

  beforeEach(() => {
    __resetDiagnosticsRetentionStoreForTests();
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
    __resetDiagnosticsRetentionStoreForTests();
  });

  it('resets in-memory + persisted retention preferences during clearPersistentUiState', async () => {
    const store = useDiagnosticsRetentionStore.getState();
    store.setMaxAgeDays(7);
    store.setMaxRows(5000);

    await clearPersistentUiState({ skipIndexedDb: true });

    const state = useDiagnosticsRetentionStore.getState();
    expect(state.maxAgeDays).toBe(30);
    expect(state.maxRows).toBe(20_000);
  });
});
