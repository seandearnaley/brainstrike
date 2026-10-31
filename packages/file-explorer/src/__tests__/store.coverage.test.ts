import type { FileExplorerState } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('store coverage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('saves a store in localStorage', async () => {
    const { createFileExplorerStore } = await import('../store');

    createFileExplorerStore().getState().setQuickFilter('saved-filter');

    expect(localStorage.getItem('brainstrike:file-explorer-storage-v5')).toContain('saved-filter');
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
