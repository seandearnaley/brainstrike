import { createMemoryStorageAdapter } from '@brainstrike/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createContextExplorerLayoutStore } from '../stores/context-explorer-layout-store';

const STORE_NAME = 'context-explorer-layout-store.v1';
const GLOBAL_STORE_KEY = '__brainstrike_context_explorer_layout_store__';

function getPersistApi(store: unknown): {
  clearStorage: () => Promise<void>;
  rehydrate: () => Promise<void>;
} {
  const persistApi = (
    store as unknown as {
      persist?: { clearStorage?: () => Promise<void>; rehydrate?: () => Promise<void> };
    }
  ).persist;
  if (!(persistApi?.clearStorage && persistApi.rehydrate)) {
    throw new Error('expected context explorer layout store persist API');
  }
  return { clearStorage: persistApi.clearStorage, rehydrate: persistApi.rehydrate };
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
    expect(state.explorerActiveTab).toBe('explorer');
  });

  it('sets the explorer active tab', () => {
    store.getState().setExplorerActiveTab('search');
    expect(store.getState().explorerActiveTab).toBe('search');

    store.getState().setExplorerActiveTab('explorer');
    expect(store.getState().explorerActiveTab).toBe('explorer');
  });

  it('persists the explorer active tab through partialize', async () => {
    const storage = createMemoryStorageAdapter();
    const persistedStore = createContextExplorerLayoutStore(storage);

    persistedStore.getState().setExplorerActiveTab('search');

    const raw = await storage.getItem(STORE_NAME);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as {
      state: { explorerActiveTab?: string };
      version: number;
    };
    expect(parsed.state.explorerActiveTab).toBe('search');
    expect(parsed.version).toBe(3);
  });

  it('migrates a v2 payload to v3 defaulting explorerActiveTab to explorer', async () => {
    const storage = createMemoryStorageAdapter();
    await storage.setItem(
      STORE_NAME,
      JSON.stringify({
        state: {
          showConsole: false,
          showLeftPanel: false,
          showRightPanel: true,
          sizes: [25, 20, 20],
        },
        version: 2,
      })
    );

    const persistedStore = createContextExplorerLayoutStore(storage);
    await getPersistApi(persistedStore).rehydrate();

    expect(persistedStore.getState().explorerActiveTab).toBe('explorer');
  });

  it('preserves a persisted v3 explorerActiveTab during rehydration', async () => {
    const storage = createMemoryStorageAdapter();
    await storage.setItem(
      STORE_NAME,
      JSON.stringify({
        state: {
          explorerActiveTab: 'search',
          showConsole: false,
          showLeftPanel: false,
          showRightPanel: true,
          sizes: [25, 20, 20],
        },
        version: 3,
      })
    );

    const persistedStore = createContextExplorerLayoutStore(storage);
    await getPersistApi(persistedStore).rehydrate();

    expect(persistedStore.getState().explorerActiveTab).toBe('search');
  });

  it('toggles panel visibility and accepts direct partial state updates', () => {
    store.getState().toggleLeft();
    store.getState().toggleRight();
    store.getState().toggleConsole();

    expect(store.getState()).toMatchObject({
      showConsole: true,
      showLeftPanel: true,
      showRightPanel: false,
    });

    store.getState().setState({ showConsole: false, sizes: [30, 30, 40] });

    expect(store.getState()).toMatchObject({
      showConsole: false,
      sizes: [30, 30, 40],
    });
  });

  it('normalizes direct size updates without corrupting omitted panel sizes', () => {
    store.getState().setSizes([80, 80, 0]);
    expect(store.getState().sizes).toEqual([50, 50, 0]);

    store.getState().setSizes([0, 0, 0]);
    expect(store.getState().sizes).toEqual([100 / 3, 100 / 3, 100 / 3]);

    store.getState().setSizes([42]);
    expect(store.getState().sizes).toEqual([42, 100 / 3, 100 / 3]);

    store.getState().setSizes([]);
    expect(store.getState().sizes).toEqual([42, 100 / 3, 100 / 3]);
  });

  it('repairs corrupted direct size updates', () => {
    store.getState().setSizes([4, 30, 20]);

    expect(store.getState().sizes).toEqual(DEFAULT_SIZES);
  });

  it('ignores persisted payloads without state', async () => {
    const storage = createMemoryStorageAdapter();
    await storage.setItem(STORE_NAME, JSON.stringify({ version: 2 }));

    const persistedStore = createContextExplorerLayoutStore(storage);
    await getPersistApi(persistedStore).rehydrate();

    expect(persistedStore.getState().sizes).toEqual(DEFAULT_SIZES);
    expect(persistedStore.getState().showLeftPanel).toBe(false);
    expect(persistedStore.getState().showRightPanel).toBe(true);
    expect(persistedStore.getState().showConsole).toBe(false);
  });

  it('removes adapter-backed persisted state through the persist API', async () => {
    const storage = createMemoryStorageAdapter();
    const persistedStore = createContextExplorerLayoutStore(storage);

    persistedStore.getState().setState({
      showConsole: true,
      sizes: [30, 30, 40],
    });
    expect(await storage.getItem(STORE_NAME)).not.toBeNull();

    await getPersistApi(persistedStore).clearStorage();

    expect(await storage.getItem(STORE_NAME)).toBeNull();
  });

  it('migrates from v1 to v2 by swapping panel visibility and sizes', async () => {
    const storage = createMemoryStorageAdapter();
    await storage.setItem(
      STORE_NAME,
      JSON.stringify({
        state: {
          showConsole: true,
          showLeftPanel: true,
          showRightPanel: false,
          sizes: [30, 15, 10],
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

  it('migrates incomplete v1 panel visibility to the v2 default layout', async () => {
    const storage = createMemoryStorageAdapter();
    await storage.setItem(
      STORE_NAME,
      JSON.stringify({
        state: {
          showConsole: true,
          sizes: [30, 15, 10],
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
          showConsole: true,
          showLeftPanel: false,
          showRightPanel: true,
          sizes: [30, 25, 15],
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
          showConsole: true,
          showLeftPanel: false,
          showRightPanel: true,
          sizes: [4.488, 5.386, 0],
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

  it('ignores malformed persisted layout JSON during rehydration', async () => {
    const storage = createMemoryStorageAdapter();
    await storage.setItem(STORE_NAME, '{not-json');

    const persistedStore = createContextExplorerLayoutStore(storage);
    await getPersistApi(persistedStore).rehydrate();

    expect(persistedStore.getState().sizes).toEqual(DEFAULT_SIZES);
    expect(persistedStore.getState().showLeftPanel).toBe(false);
    expect(persistedStore.getState().showRightPanel).toBe(true);
    expect(persistedStore.getState().showConsole).toBe(false);
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
          showConsole: true,
          showLeftPanel: false,
          showRightPanel: true,
          sizes,
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

  it('creates the module singleton with fallback storage when browser storage is unavailable', async () => {
    const globalRecord = globalThis as unknown as Record<string, unknown>;
    const originalSingleton = globalRecord[GLOBAL_STORE_KEY];
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    globalRecord[GLOBAL_STORE_KEY] = vi.fn();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: undefined,
    });
    vi.resetModules();
    vi.doMock('@brainstrike/storage', async () => {
      const actual =
        await vi.importActual<typeof import('@brainstrike/storage')>('@brainstrike/storage');
      return {
        ...actual,
        createBrowserStorageAdapter: vi.fn(() => {
          throw new Error('browser storage unavailable');
        }),
      };
    });

    try {
      const module = await import('../stores/context-explorer-layout-store');
      const singleton = module.useContextExplorerLayoutStore;

      singleton.getState().setSizes([30, 30, 40]);
      expect(singleton.getState().sizes).toEqual([30, 30, 40]);
      await getPersistApi(singleton).rehydrate();
      await getPersistApi(singleton).clearStorage();
    } finally {
      vi.doUnmock('@brainstrike/storage');
      vi.resetModules();
      if (originalWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
      }
      if (originalSingleton === undefined) {
        delete globalRecord[GLOBAL_STORE_KEY];
      } else {
        globalRecord[GLOBAL_STORE_KEY] = originalSingleton;
      }
    }
  });
});
