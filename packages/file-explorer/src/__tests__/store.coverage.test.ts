import type { FileExplorerState } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORE_KEY = '__brainstrike_file_explorer_store__';
const STORE_BRAND = '__brainstrike_store_brand__';

describe('store coverage', () => {
  beforeEach(() => {
    vi.resetModules();
    delete (globalThis as Record<string, unknown>)[STORE_KEY];
    localStorage.clear();
  });

  it('saves the default store in localStorage', async () => {
    const { useFileExplorerStore } = await import('../store');

    useFileExplorerStore.getState().setQuickFilter('saved-filter');

    expect(localStorage.getItem('file-explorer-storage-v5')).toContain('saved-filter');
  });

  it('reuses a valid branded singleton from globalThis', async () => {
    const existingStore = Object.assign(vi.fn(), {
      getState: vi.fn(),
      setState: vi.fn(),
      [STORE_BRAND]: 2,
    });
    (globalThis as Record<string, unknown>)[STORE_KEY] = existingStore;

    const mod = await import('../store');

    expect(mod.useFileExplorerStore).toBe(existingStore);
  });

  it('replaces a previous cache-lifetime branded singleton', async () => {
    const invalidStore = Object.assign(vi.fn(), {
      getState: vi.fn(),
      setState: vi.fn(),
      [STORE_BRAND]: 1,
    });
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
