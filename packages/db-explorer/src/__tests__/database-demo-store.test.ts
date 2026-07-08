import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetDatabaseDemoStoreForTests,
  databaseDemoSelectors,
  useDatabaseDemoStore,
} from '../stores/database-demo-store';

interface PersistedDatabaseDemoStore {
  expandedFileIds?: string[];
  recordPage?: number;
  recordPageSize?: number;
  searchQuery?: string;
  searchThreshold?: number;
  showSettings?: boolean;
}

describe('database-demo-store', () => {
  beforeEach(() => {
    __resetDatabaseDemoStoreForTests();
    localStorage.removeItem('database-demo.v2');
  });

  it('does not persist transient settings popover state', async () => {
    useDatabaseDemoStore.getState().setShowSettings(true);

    const stored = localStorage.getItem('database-demo.v2');
    expect(stored).toBeTruthy();

    const parsed = JSON.parse(stored ?? 'null') as {
      state?: PersistedDatabaseDemoStore;
      version?: number;
    } | null;

    expect(parsed?.version).toBe(3);
    expect(parsed?.state?.showSettings).toBeUndefined();
  });

  it('migrates legacy snapshots to close the settings popover on hydration', async () => {
    localStorage.setItem(
      'database-demo.v2',
      JSON.stringify({
        state: {
          expandedFileIds: ['file-1'],
          recordPage: 2,
          recordPageSize: 25,
          searchQuery: 'report',
          searchThreshold: 0.7,
          showSettings: true,
        } satisfies PersistedDatabaseDemoStore,
        version: 2,
      })
    );

    const persistApi = (
      useDatabaseDemoStore as unknown as { persist?: { rehydrate?: () => Promise<void> } }
    ).persist;

    await persistApi?.rehydrate?.();

    const state = useDatabaseDemoStore.getState();
    expect(state.showSettings).toBe(false);
    expect(state.expandedFileIds).toEqual(['file-1']);
    expect(state.recordPage).toBe(2);
    expect(state.recordPageSize).toBe(25);
    expect(state.searchQuery).toBe('report');
    expect(state.searchThreshold).toBe(0.7);
  });

  it('migrates non-object legacy snapshots to the default closed settings state', async () => {
    localStorage.setItem(
      'database-demo.v2',
      JSON.stringify({
        state: 'corrupted',
        version: 2,
      })
    );

    const persistApi = (
      useDatabaseDemoStore as unknown as { persist?: { rehydrate?: () => Promise<void> } }
    ).persist;

    await persistApi?.rehydrate?.();

    const state = useDatabaseDemoStore.getState();
    expect(state.showSettings).toBe(false);
    expect(state.expandedFileIds).toEqual([]);
    expect(state.recordPage).toBe(0);
    expect(state.recordPageSize).toBe(50);
    expect(state.searchQuery).toBe('');
    expect(state.searchThreshold).toBe(0.5);
  });

  it('updates expanded file ids with deduping actions', () => {
    const store = useDatabaseDemoStore.getState();

    store.addExpanded('file-1');
    store.addExpanded('file-1');
    store.addExpanded('file-2');
    expect(useDatabaseDemoStore.getState().expandedFileIds).toEqual(['file-1', 'file-2']);

    useDatabaseDemoStore.getState().removeExpanded('file-1');
    expect(useDatabaseDemoStore.getState().expandedFileIds).toEqual(['file-2']);

    useDatabaseDemoStore.getState().setExpanded(['file-3', 'file-3', 'file-4']);
    expect(useDatabaseDemoStore.getState().expandedFileIds).toEqual(['file-3', 'file-4']);

    useDatabaseDemoStore.getState().clearExpanded();
    expect(useDatabaseDemoStore.getState().expandedFileIds).toEqual([]);
  });

  it('normalizes pagination and search settings', () => {
    const store = useDatabaseDemoStore.getState();

    store.setRecordPage(2.9);
    expect(useDatabaseDemoStore.getState().recordPage).toBe(2);

    useDatabaseDemoStore.getState().setRecordPage(-4);
    expect(useDatabaseDemoStore.getState().recordPage).toBe(0);

    useDatabaseDemoStore.getState().setRecordPage(Number.NaN);
    expect(useDatabaseDemoStore.getState().recordPage).toBe(0);

    useDatabaseDemoStore.getState().setRecordPage(5);
    useDatabaseDemoStore.getState().setRecordPageSize(25.8);
    expect(useDatabaseDemoStore.getState()).toEqual(
      expect.objectContaining({ recordPage: 0, recordPageSize: 25 })
    );

    useDatabaseDemoStore.getState().setRecordPageSize(0);
    expect(useDatabaseDemoStore.getState().recordPageSize).toBe(50);

    useDatabaseDemoStore.getState().setRecordPage(3);
    useDatabaseDemoStore.getState().resetRecordPagination();
    expect(useDatabaseDemoStore.getState().recordPage).toBe(0);

    useDatabaseDemoStore.getState().setSearchQuery('embedding');
    useDatabaseDemoStore.getState().setSearchThreshold(2);
    expect(useDatabaseDemoStore.getState()).toEqual(
      expect.objectContaining({ searchQuery: 'embedding', searchThreshold: 1 })
    );

    useDatabaseDemoStore.getState().setSearchThreshold(-1);
    expect(useDatabaseDemoStore.getState().searchThreshold).toBe(0);

    useDatabaseDemoStore.getState().setSearchThreshold(Number.NaN);
    expect(useDatabaseDemoStore.getState().searchThreshold).toBe(0.5);
  });

  it('selects settings, expansion, pagination, and search slices', () => {
    const store = useDatabaseDemoStore.getState();

    store.setShowSettings(true);
    store.setExpanded(['file-1']);
    store.setRecordPage(4);
    store.setRecordPageSize(10);
    store.setSearchQuery('report');
    store.setSearchThreshold(0.8);

    const state = useDatabaseDemoStore.getState();
    expect(databaseDemoSelectors.settings(state)).toBe(true);
    expect(databaseDemoSelectors.expanded(state)).toEqual(['file-1']);
    expect(databaseDemoSelectors.pagination(state)).toEqual([0, 10]);
    expect(databaseDemoSelectors.search(state)).toEqual(['report', 0.8]);
  });

  it('swallows storage clearing failures in the test reset helper', () => {
    const persistApi = (
      useDatabaseDemoStore as unknown as { persist?: { clearStorage?: () => void } }
    ).persist;
    if (!persistApi?.clearStorage) {
      throw new Error('expected database demo store persist API');
    }

    const originalClearStorage = persistApi.clearStorage;
    persistApi.clearStorage = () => {
      throw new Error('storage unavailable');
    };

    expect(() => __resetDatabaseDemoStoreForTests()).not.toThrow();

    persistApi.clearStorage = originalClearStorage;
  });
});
