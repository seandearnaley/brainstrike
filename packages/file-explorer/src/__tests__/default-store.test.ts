import { beforeEach, describe, expect, it, vi } from 'vitest';

// Ensure fresh module import for each test
beforeEach(() => {
  vi.resetModules();
});

describe('default store creation without localStorage', () => {
  it('uses MemoryStorageAdapter when localStorage is unavailable', async () => {
    // localStorage should be undefined in this environment
    expect((globalThis as unknown as { localStorage?: unknown }).localStorage).toBeUndefined();

    const mod = await import('../store');
    const { useFileExplorerStore } = mod;

    useFileExplorerStore.getState().setCurrentFolderId('foo');
    await new Promise((r) => setTimeout(r, 50));

    const options = useFileExplorerStore.persist.getOptions();
    if (!options.storage) throw new Error('storage missing');
    const stored = await options.storage.getItem('file-explorer-storage-v4');
    expect(stored).toBeTruthy();
    if (stored) {
      interface PersistWrapper {
        state?: { currentFolderId?: string };
        currentFolderId?: string;
      }
      const persisted = stored as PersistWrapper;
      expect(persisted.state?.currentFolderId ?? persisted.currentFolderId).toBe('foo');
    }
  });
});
