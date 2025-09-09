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

  it('migrates from legacy key fileEditorTabs.v1 to tab-manager.v1', async () => {
    const legacy = {
      tabs: [
        { id: 'a', path: '/src/a.ts', compositeKey: 'a' },
        { id: 'b', path: '/src/b.ts', compositeKey: 'b' },
      ],
      activeTabId: 'a',
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
      state.tabs.map((t) => ({ id: t.id, path: t.path, compositeKey: t.compositeKey }))
    ).toEqual(legacy.tabs);

    // New key should exist; old key removed
    expect(localStorage.getItem('tab-manager.v1')).toBeTruthy();
    expect(localStorage.getItem('fileEditorTabs.v1')).toBeNull();
  });
});
