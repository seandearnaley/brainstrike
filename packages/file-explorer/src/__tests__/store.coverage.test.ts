import type { FileExplorerState } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORE_KEY = '__brainstrike_file_explorer_store__';
const STORE_BRAND = '__brainstrike_store_brand__';

function createLocalStorageMock() {
  const values = new Map<string, string>();
  return {
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

describe('store coverage', () => {
  beforeEach(() => {
    vi.resetModules();
    delete (globalThis as Record<string, unknown>)[STORE_KEY];
    (globalThis as Record<string, unknown>).localStorage = undefined;
  });

  it('uses browser localStorage when it is available', async () => {
    const localStorageMock = createLocalStorageMock();
    (globalThis as Record<string, unknown>).localStorage = localStorageMock;

    const mod = await import('../store');
    const { useFileExplorerStore } = mod;
    const storage = useFileExplorerStore.persist.getOptions().storage;

    await storage?.setItem('store-key', 'store-value');
    const result = await storage?.getItem('store-key');
    await storage?.removeItem('store-key');

    expect(result).toBe('store-value');
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'store-key',
      JSON.stringify('store-value')
    );
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('store-key');
  }, 15_000);

  it('reuses a valid branded singleton from globalThis', async () => {
    const existingStore = Object.assign(vi.fn(), {
      getState: vi.fn(),
      setState: vi.fn(),
      [STORE_BRAND]: 1,
    });
    (globalThis as Record<string, unknown>)[STORE_KEY] = existingStore;

    const mod = await import('../store');

    expect(mod.useFileExplorerStore).toBe(existingStore);
  });

  it('replaces an invalid cached singleton that is missing the branded api', async () => {
    const invalidStore = {
      getState: vi.fn(),
      setState: vi.fn(),
      [STORE_BRAND]: 99,
    };
    (globalThis as Record<string, unknown>)[STORE_KEY] = invalidStore;

    const mod = await import('../store');

    expect(mod.useFileExplorerStore).not.toBe(invalidStore);
    expect(typeof mod.useFileExplorerStore.getState).toBe('function');
  });

  it('stateCreator wires explorer-only setter actions', async () => {
    const set = vi.fn();
    const get = vi.fn(() => ({}) as FileExplorerState);
    const { stateCreator } = await import('../store');

    const state = stateCreator(set, get, undefined as never);

    state.setQuickFilter('ts only');
    state.clearQuickFilter();
    state.setDevInlineFixtureEnabled(true);
    state.setIsAccessLoading(true);
    state.setFiltersExpanded(true);
    state.setFilterChipsVisible(false);

    expect(set).toHaveBeenNthCalledWith(1, { quickFilter: 'ts only' });
    expect(set).toHaveBeenNthCalledWith(2, { quickFilter: '' });
    expect(set).toHaveBeenNthCalledWith(3, { devInlineFixtureEnabled: true });
    expect(set).toHaveBeenNthCalledWith(4, { isAccessLoading: true });
    expect(set).toHaveBeenNthCalledWith(5, { isFiltersExpanded: true });
    expect(set).toHaveBeenNthCalledWith(6, { isFilterChipsVisible: false });
  });
});
