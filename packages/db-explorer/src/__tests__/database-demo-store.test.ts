import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetDatabaseDemoStoreForTests,
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
          showSettings: true,
          expandedFileIds: ['file-1'],
          recordPage: 2,
          recordPageSize: 25,
          searchQuery: 'report',
          searchThreshold: 0.7,
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
