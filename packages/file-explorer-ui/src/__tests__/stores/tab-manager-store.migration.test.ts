import { beforeEach, describe, expect, it } from 'vitest';
import { __resetTabManagerStoreForTests, useTabManagerStore } from '../../stores/tab-manager-store';

describe('tab-manager-store migration', () => {
  beforeEach(() => {
    __resetTabManagerStoreForTests();
    // Clear any prior localStorage
    try {
      localStorage.removeItem('tab-manager.v1');
      localStorage.removeItem('fileEditorTabs.v1');
    } catch {}
  });

  it('migrates from legacy key fileEditorTabs.v1 to tab-manager.v1 (compositeKey-based ids)', async () => {
    const legacy = {
      activeTabId: 'a',
      tabs: [
        { compositeKey: 'a', id: 'a', path: '/src/a.ts' },
        { compositeKey: 'b', id: 'b', path: '/src/b.ts' },
      ],
    };
    // Seed legacy storage
    localStorage.setItem('fileEditorTabs.v1', JSON.stringify(legacy));

    // Force rehydrate
    const persistApi = (
      useTabManagerStore as unknown as { persist?: { rehydrate?: () => Promise<void> } }
    ).persist;
    await persistApi?.rehydrate?.();

    const state = useTabManagerStore.getState();
    expect(state.activeTabId).toBe('a');
    expect(
      state.tabs.map((t) => ({ compositeKey: t.compositeKey, id: t.id, path: t.path }))
    ).toEqual(legacy.tabs);

    // New key should exist; old key removed
    expect(localStorage.getItem('tab-manager.v1')).toBeTruthy();
    expect(localStorage.getItem('fileEditorTabs.v1')).toBeNull();
  });

  it('end-to-end: legacy key with prefixed tabIds → safe-storage migration → v1→v2 → final state', async () => {
    // Seed the legacy fileEditorTabs.v1 key with v1-shape data (prefixed tabIds).
    // The full migration chain is:
    //   1. createSafeJsonStateStorage.migrateOnGet (rename key, wrap as version: 1)
    //   2. Zustand persist's migrate hook (collapse tabIds, dedupe, fix activeTabId)
    // This test pins the round-trip through both layers — the existing tests above
    // cover each layer in isolation.
    const legacyV1 = {
      activeTabId: 'root-folder-xyz:folderA|@|src/index.ts',
      tabs: [
        {
          compositeKey: 'folderA|@|src/index.ts',
          id: 'root-folder-abc:folderA|@|src/index.ts',
          path: 'src/index.ts',
        },
        // Same compositeKey under a different rootFolderId — exercises the v1→v2 dedupe.
        {
          compositeKey: 'folderA|@|src/index.ts',
          id: 'root-folder-xyz:folderA|@|src/index.ts',
          path: 'src/index.ts',
        },
        {
          compositeKey: 'folderA|@|src/app.ts',
          id: 'root-folder-abc:folderA|@|src/app.ts',
          path: 'src/app.ts',
        },
      ],
    };
    localStorage.setItem('fileEditorTabs.v1', JSON.stringify(legacyV1));

    const persistApi = (
      useTabManagerStore as unknown as { persist?: { rehydrate?: () => Promise<void> } }
    ).persist;
    await persistApi?.rehydrate?.();

    const state = useTabManagerStore.getState();
    // After both layers run: ids collapsed to compositeKey, dupes deduped, active id
    // remapped (xyz: prefix stripped, points at the deduped survivor).
    expect(state.tabs.map((t) => t.id)).toEqual(['folderA|@|src/index.ts', 'folderA|@|src/app.ts']);
    expect(state.activeTabId).toBe('folderA|@|src/index.ts');

    // Legacy key was renamed away by the safe-storage migration.
    expect(localStorage.getItem('fileEditorTabs.v1')).toBeNull();
    expect(localStorage.getItem('tab-manager.v1')).toBeTruthy();
  });

  it('v1 → v2: collapses prefixed tabIds (`<root>:<compositeKey>`) to compositeKey', async () => {
    const v1 = {
      state: {
        activeTabId: 'root-folder-abc:folderA|@|src/index.ts',
        tabs: [
          {
            compositeKey: 'folderA|@|src/index.ts',
            id: 'root-folder-abc:folderA|@|src/index.ts',
            path: 'src/index.ts',
          },
          {
            compositeKey: 'folderA|@|src/app.ts',
            id: 'root-folder-abc:folderA|@|src/app.ts',
            path: 'src/app.ts',
          },
        ],
      },
      version: 1,
    };
    localStorage.setItem('tab-manager.v1', JSON.stringify(v1));

    const persistApi = (
      useTabManagerStore as unknown as { persist?: { rehydrate?: () => Promise<void> } }
    ).persist;
    await persistApi?.rehydrate?.();

    const state = useTabManagerStore.getState();
    expect(state.tabs.map((t) => t.id)).toEqual(['folderA|@|src/index.ts', 'folderA|@|src/app.ts']);
    expect(state.activeTabId).toBe('folderA|@|src/index.ts');
  });
});
