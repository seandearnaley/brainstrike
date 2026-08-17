/**
 * FACTORY RESET CONTRACT for the Explorer tree-grid layout stores (BST-1208,
 * whole-branch review F6).
 *
 * `clearPersistentUiState` calls `localStorage.clear()`, which drops the
 * persisted slice — but the web reset path does not force a reload, so the LIVE
 * singleton survives it. Without an explicit reset the grid kept the user's
 * hidden columns and dragged widths straight through a factory reset.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPersistentUiState } from '../factory-reset';
import {
  EXPLORER_COLUMN_BOUNDS,
  useExplorerColumnSizesStore,
} from '../stores/explorer-column-sizes-store';
import { useExplorerColumnVisibilityStore } from '../stores/explorer-column-visibility-store';

const globalWindow = window as Window &
  typeof globalThis & {
    caches?: CacheStorage;
  };

describe('factory reset wires the Explorer column stores', () => {
  let originalCaches: CacheStorage | undefined;

  beforeEach(() => {
    useExplorerColumnSizesStore.getState().reset();
    useExplorerColumnVisibilityStore.getState().reset();
    originalCaches = globalWindow.caches;
    // An empty CacheStorage keeps clearPersistentUiState off the
    // cache-verification failure path; this test only cares about the stores.
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
    useExplorerColumnSizesStore.getState().reset();
    useExplorerColumnVisibilityStore.getState().reset();
  });

  it('restores the live singletons, not just the persisted slice', async () => {
    useExplorerColumnSizesStore
      .getState()
      .setColumn('tokens', EXPLORER_COLUMN_BOUNDS.tokens.maxWidth);
    useExplorerColumnVisibilityStore.getState().setColumnVisible('tokens', false);
    expect(useExplorerColumnSizesStore.getState().sizes['tokens']).toBe(
      EXPLORER_COLUMN_BOUNDS.tokens.maxWidth
    );
    expect(useExplorerColumnVisibilityStore.getState().tokens).toBe(false);

    await clearPersistentUiState({ skipIndexedDb: true });

    expect(useExplorerColumnSizesStore.getState().sizes['tokens']).toBe(
      EXPLORER_COLUMN_BOUNDS.tokens.defaultWidth
    );
    // Tokens is the one column ON by default; a reset must bring it back.
    expect(useExplorerColumnVisibilityStore.getState().tokens).toBe(true);
  });
});
