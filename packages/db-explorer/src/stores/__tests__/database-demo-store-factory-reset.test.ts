import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetDatabaseDemoStoreForTests,
  resetDatabaseDemoStoreToDefault,
  useDatabaseDemoStore,
} from '../database-demo-store';

afterEach(() => {
  __resetDatabaseDemoStoreForTests();
});

describe('resetDatabaseDemoStoreToDefault (PR #2381 review)', () => {
  /**
   * Web factory reset is a blanket `localStorage.clear()`, which drops the
   * PERSISTED slice — but this store is a mounted singleton, so without a live
   * resetter the collection debug drawer stayed open on the running instance
   * and kept querying the database the reset had just emptied.
   */
  it('closes the debug drawer on the live store instance', () => {
    useDatabaseDemoStore.getState().setDebugDrawerOpen(true);
    expect(useDatabaseDemoStore.getState().debugDrawerOpen).toBe(true);

    resetDatabaseDemoStoreToDefault();

    expect(useDatabaseDemoStore.getState().debugDrawerOpen).toBe(false);
  });

  it('restores every persisted slice to its default, not just the drawer', () => {
    const store = useDatabaseDemoStore.getState();
    store.setDebugDrawerOpen(true);
    store.setRecordPage(4);
    store.setRecordPageSize(200);
    store.setSearchQuery('stale');
    store.setSearchThreshold(0.9);
    store.setExpanded(['file-1']);
    store.setShowSettings(true);

    resetDatabaseDemoStoreToDefault();

    expect(useDatabaseDemoStore.getState()).toMatchObject({
      debugDrawerOpen: false,
      expandedFileIds: [],
      recordPage: 0,
      recordPageSize: 50,
      searchQuery: '',
      searchThreshold: 0.5,
      showSettings: false,
    });
  });
});
