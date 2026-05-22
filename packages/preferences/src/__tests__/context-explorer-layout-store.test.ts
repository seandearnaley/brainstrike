import { createMemoryStorageAdapter } from '@brainstrike/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import { createContextExplorerLayoutStore } from '../stores/context-explorer-layout-store';

const STORE_NAME = 'context-explorer-layout-store.v1';

function getPersistApi(store: ReturnType<typeof createContextExplorerLayoutStore>): {
  rehydrate: () => Promise<void>;
} {
  const persistApi = (store as unknown as { persist?: { rehydrate?: () => Promise<void> } })
    .persist;
  if (!persistApi?.rehydrate) {
    throw new Error('expected context explorer layout store persist API');
  }
  return { rehydrate: persistApi.rehydrate };
}

describe('context-explorer-layout-store', () => {
  const DEFAULT_SIZES = [25, 20, 20] as const;
  let store: ReturnType<typeof createContextExplorerLayoutStore>;

  beforeEach(() => {
    store = createContextExplorerLayoutStore(createMemoryStorageAdapter());
  });

  it('initializes with default state', () => {
    const state = store.getState();
    expect(state.sizes).toEqual(DEFAULT_SIZES);
    expect(state.showLeftPanel).toBe(false);
    expect(state.showRightPanel).toBe(true);
    expect(state.showConsole).toBe(false);
  });

  it('migrates from v1 to v2 by swapping panel visibility and sizes', async () => {
    const storage = createMemoryStorageAdapter();
    await storage.setItem(
      STORE_NAME,
      JSON.stringify({
        state: {
          sizes: [30, 15, 10],
          showLeftPanel: true,
          showRightPanel: false,
          showConsole: true,
        },
        version: 1,
      })
    );

    const persistedStore = createContextExplorerLayoutStore(storage);
    await getPersistApi(persistedStore).rehydrate();

    expect(persistedStore.getState().sizes).toEqual([15, 30, 10]);
    expect(persistedStore.getState().showLeftPanel).toBe(false);
    expect(persistedStore.getState().showRightPanel).toBe(true);
    expect(persistedStore.getState().showConsole).toBe(true);
  });

  it('preserves the persisted version during rehydration', async () => {
    const storage = createMemoryStorageAdapter();
    await storage.setItem(
      STORE_NAME,
      JSON.stringify({
        state: {
          sizes: [30, 25, 15],
          showLeftPanel: false,
          showRightPanel: true,
          showConsole: true,
        },
        version: 7,
      })
    );

    const persistedStore = createContextExplorerLayoutStore(storage);
    await getPersistApi(persistedStore).rehydrate();

    expect(persistedStore.getState().sizes).toEqual([30, 25, 15]);
    expect(persistedStore.getState().showLeftPanel).toBe(false);
    expect(persistedStore.getState().showRightPanel).toBe(true);
    expect(persistedStore.getState().showConsole).toBe(true);
  });

  it('repairs corrupted persisted sizes during rehydration', async () => {
    const storage = createMemoryStorageAdapter();
    await storage.setItem(
      STORE_NAME,
      JSON.stringify({
        state: {
          sizes: [4.488, 5.386, 0],
          showLeftPanel: false,
          showRightPanel: true,
          showConsole: true,
        },
        version: 2,
      })
    );

    const persistedStore = createContextExplorerLayoutStore(storage);
    await getPersistApi(persistedStore).rehydrate();

    expect(persistedStore.getState().sizes).toEqual(DEFAULT_SIZES);
    expect(persistedStore.getState().showLeftPanel).toBe(false);
    expect(persistedStore.getState().showRightPanel).toBe(true);
    expect(persistedStore.getState().showConsole).toBe(true);
  });

  it.each([
    { label: 'negative sizes', sizes: [-5, 25, 20] },
    { label: 'non-numeric sizes', sizes: ['25', 20, 20] },
    { label: 'wrong-length sizes', sizes: [25, 20] },
  ])('repairs $label during rehydration', async ({ sizes }) => {
    const storage = createMemoryStorageAdapter();
    await storage.setItem(
      STORE_NAME,
      JSON.stringify({
        state: {
          sizes,
          showLeftPanel: false,
          showRightPanel: true,
          showConsole: true,
        },
        version: 2,
      })
    );

    const persistedStore = createContextExplorerLayoutStore(storage);
    await getPersistApi(persistedStore).rehydrate();

    expect(persistedStore.getState().sizes).toEqual(DEFAULT_SIZES);
    expect(persistedStore.getState().showLeftPanel).toBe(false);
    expect(persistedStore.getState().showRightPanel).toBe(true);
    expect(persistedStore.getState().showConsole).toBe(true);
  });
});
