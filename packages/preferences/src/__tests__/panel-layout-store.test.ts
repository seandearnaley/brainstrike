import { createMemoryStorageAdapter } from '@brainstrike/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPanelLayoutStore } from '../stores/panel-layout-store';

const STORE_NAME = 'panel-layout-store.v1';

function getPersistApi(store: ReturnType<typeof createPanelLayoutStore>): {
  rehydrate: () => Promise<void>;
} {
  const persistApi = (store as unknown as { persist?: { rehydrate?: () => Promise<void> } })
    .persist;
  if (!persistApi?.rehydrate) {
    throw new Error('expected panel layout store persist API');
  }
  return { rehydrate: persistApi.rehydrate };
}

describe('panel-layout-store', () => {
  const DEFAULT_SIZES = [18, 40, 20] as const;
  let store: ReturnType<typeof createPanelLayoutStore>;

  beforeEach(() => {
    store = createPanelLayoutStore(createMemoryStorageAdapter());
  });

  it('initializes with default state', () => {
    const s = store.getState();
    expect(s.sizes).toEqual(DEFAULT_SIZES);
    expect(s.showLeftPanel).toBe(true);
    expect(s.showRightPanel).toBe(true);
    expect(s.showConsole).toBe(false);
    expect(s.activeTab).toBe('explorer');
  });

  it('toggles panel visibility flags', () => {
    const before = store.getState();
    expect(before.showLeftPanel).toBe(true);
    expect(before.showRightPanel).toBe(true);
    expect(before.showConsole).toBe(false);

    store.getState().toggleLeft();
    store.getState().toggleRight();
    store.getState().toggleConsole();

    const after = store.getState();
    expect(after.showLeftPanel).toBe(false);
    expect(after.showRightPanel).toBe(false);
    expect(after.showConsole).toBe(true);
  });

  it('sets active tab', () => {
    expect(store.getState().activeTab).toBe('explorer');
    store.getState().setActiveTab('settings');
    expect(store.getState().activeTab).toBe('settings');
  });

  it('normalizes sizes and preserves tuple shape', () => {
    store.getState().setSizes([200, -10, Number.NaN]);
    const s = store.getState();
    // normalizeSizes clamps into [0..100] and prevents NaN; preserves existing slots where undefined
    expect(s.sizes.length).toBe(3);
    expect(s.sizes[0]).toBe(100); // 200 -> 100
    expect(s.sizes[1]).toBe(0); // -10 -> 0
    expect(typeof s.sizes[2]).toBe('number');
  });

  it('setState merges partial updates', () => {
    store.getState().setState({ showRightPanel: true, activeTab: 'settings' });
    const s = store.getState();
    expect(s.showRightPanel).toBe(true);
    expect(s.activeTab).toBe('settings');
    // unchanged remain
    expect(s.showLeftPanel).toBe(true);
  });

  it('supports prompts tab', () => {
    store.getState().setActiveTab('prompts');
    expect(store.getState().activeTab).toBe('prompts');
  });

  it('resets corrupted sizes below minimum threshold to defaults', () => {
    // Sizes like [4.488, 5.386, 0] represent corrupted localStorage values
    store.getState().setSizes([4.488, 5.386, 0]);
    const s = store.getState();
    expect(s.sizes).toEqual(DEFAULT_SIZES);
  });

  it('preserves valid sizes above minimum threshold', () => {
    store.getState().setSizes([30, 25, 15]);
    const s = store.getState();
    expect(s.sizes).toEqual([30, 25, 15]);
  });

  it('leaves sizes unchanged when setSizes receives an empty array', () => {
    store.getState().setSizes([]);
    expect(store.getState().sizes).toEqual(DEFAULT_SIZES);
  });

  it('redistributes all-zero sizes evenly', () => {
    store.getState().setSizes([0, 0, 0]);
    expect(store.getState().sizes).toEqual([100 / 3, 100 / 3, 100 / 3]);
  });

  it('scales oversized size totals back to 100%', () => {
    store.getState().setSizes([60, 60, 60]);
    const sizes = store.getState().sizes;
    expect(sizes[0]).toBeCloseTo(100 / 3);
    expect(sizes[1]).toBeCloseTo(100 / 3);
    expect(sizes[2]).toBeCloseTo(100 / 3);
  });

  it('ignores invalid persisted JSON and keeps defaults', async () => {
    const storage = createMemoryStorageAdapter();
    await storage.setItem(STORE_NAME, '{invalid json');

    const persistedStore = createPanelLayoutStore(storage);
    await getPersistApi(persistedStore).rehydrate();

    expect(persistedStore.getState().sizes).toEqual(DEFAULT_SIZES);
    expect(persistedStore.getState().showLeftPanel).toBe(true);
    expect(persistedStore.getState().showRightPanel).toBe(true);
    expect(persistedStore.getState().showConsole).toBe(false);
  });

  it('resets persisted outer-shell visibility and sizes when the layout version changes', async () => {
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

    const persistedStore = createPanelLayoutStore(storage);
    await getPersistApi(persistedStore).rehydrate();

    expect(persistedStore.getState().sizes).toEqual(DEFAULT_SIZES);
    expect(persistedStore.getState().showLeftPanel).toBe(true);
    expect(persistedStore.getState().showRightPanel).toBe(true);
    expect(persistedStore.getState().showConsole).toBe(false);
  });

  it('treats persisted snapshots without state as empty', async () => {
    const storage = createMemoryStorageAdapter();
    await storage.setItem(
      STORE_NAME,
      JSON.stringify({
        version: 2,
      })
    );

    const persistedStore = createPanelLayoutStore(storage);
    await getPersistApi(persistedStore).rehydrate();

    expect(persistedStore.getState().sizes).toEqual(DEFAULT_SIZES);
    expect(persistedStore.getState().activeTab).toBe('explorer');
  });
});
