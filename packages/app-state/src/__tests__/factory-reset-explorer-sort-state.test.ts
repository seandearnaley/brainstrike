import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPersistentUiState } from '../factory-reset.ts';
import { useExplorerSortStateStore } from '../stores/explorer-sort-state-store.ts';

const globalWindow = window as Window &
  typeof globalThis & {
    caches?: CacheStorage;
  };

describe('factory reset wires the Explorer sort state store', () => {
  let originalCaches: CacheStorage | undefined;

  beforeEach(() => {
    useExplorerSortStateStore.getState().reset();
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
    useExplorerSortStateStore.getState().reset();
  });

  it('restores default order in the live store during clearPersistentUiState', async () => {
    useExplorerSortStateStore.getState().setSortState({ direction: 'desc', field: 'tokens' });

    await clearPersistentUiState({ skipIndexedDb: true });

    expect(useExplorerSortStateStore.getState().sortState).toBeNull();
  });
});
