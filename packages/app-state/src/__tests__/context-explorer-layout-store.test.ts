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

async function rehydratedFrom(raw: string) {
  const storage = createMemoryStorageAdapter();
  await storage.setItem(STORE_NAME, raw);
  const persistedStore = createContextExplorerLayoutStore(storage);
  await getPersistApi(persistedStore).rehydrate();
  return persistedStore;
}

describe('context-explorer-layout-store', () => {
  let store: ReturnType<typeof createContextExplorerLayoutStore>;

  beforeEach(() => {
    store = createContextExplorerLayoutStore(createMemoryStorageAdapter());
  });

  it('starts on the file tree and holds only the tab choice', () => {
    const state = store.getState();
    expect(state.explorerActiveTab).toBe('explorer');
    expect(Object.keys(state).sort()).toEqual(['explorerActiveTab', 'setExplorerActiveTab']);
  });

  it('sets the explorer active tab', () => {
    store.getState().setExplorerActiveTab('search');
    expect(store.getState().explorerActiveTab).toBe('search');

    store.getState().setExplorerActiveTab('explorer');
    expect(store.getState().explorerActiveTab).toBe('explorer');
  });

  it('persists only the explorer active tab', async () => {
    const storage = createMemoryStorageAdapter();
    const persistedStore = createContextExplorerLayoutStore(storage);

    persistedStore.getState().setExplorerActiveTab('search');

    const raw = await storage.getItem(STORE_NAME);
    expect(JSON.parse(raw as string)).toEqual({
      state: { explorerActiveTab: 'search' },
      version: 3,
    });
  });

  it('restores a persisted tab and ignores the panel fields an older snapshot carries', async () => {
    const persistedStore = await rehydratedFrom(
      JSON.stringify({
        state: {
          explorerActiveTab: 'search',
          showConsole: true,
          showLeftPanel: false,
          showRightPanel: true,
          sizes: [25, 20, 20],
        },
        version: 3,
      })
    );

    expect(persistedStore.getState().explorerActiveTab).toBe('search');
    expect(persistedStore.getState()).not.toHaveProperty('sizes');
    expect(persistedStore.getState()).not.toHaveProperty('showConsole');
  });

  it.each([
    { label: 'a snapshot written before the tab existed', state: { sizes: [25, 20, 20] } },
    { label: 'an unknown tab', state: { explorerActiveTab: 'preview' } },
  ])('reads $label as the file tree', async ({ state }) => {
    const persistedStore = await rehydratedFrom(JSON.stringify({ state, version: 2 }));
    expect(persistedStore.getState().explorerActiveTab).toBe('explorer');
  });

  it.each([
    { label: 'a payload without state', raw: JSON.stringify({ version: 3 }) },
    { label: 'malformed JSON', raw: '{not-json' },
  ])('ignores $label during rehydration', async ({ raw }) => {
    const persistedStore = await rehydratedFrom(raw);
    expect(persistedStore.getState().explorerActiveTab).toBe('explorer');
  });

  it('removes adapter-backed persisted state through the persist API', async () => {
    const storage = createMemoryStorageAdapter();
    const persistedStore = createContextExplorerLayoutStore(storage);

    persistedStore.getState().setExplorerActiveTab('search');
    expect(await storage.getItem(STORE_NAME)).not.toBeNull();

    await getPersistApi(persistedStore).clearStorage();

    expect(await storage.getItem(STORE_NAME)).toBeNull();
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

      singleton.getState().setExplorerActiveTab('search');
      expect(singleton.getState().explorerActiveTab).toBe('search');
      await getPersistApi(singleton).rehydrate();
      expect(singleton.getState().explorerActiveTab).toBe('search');
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
