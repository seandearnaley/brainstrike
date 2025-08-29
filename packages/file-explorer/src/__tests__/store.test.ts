import { MemoryStorageAdapter } from '@brainstrike/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  (globalThis as unknown as { localStorage?: unknown }).localStorage = undefined;
});

describe('useFileExplorerStore without localStorage', () => {
  it('uses MemoryStorageAdapter for persistence', async () => {
    const mod = await import('../store');
    const { useFileExplorerStore } = mod;

    useFileExplorerStore.getState().setCurrentFolderId('test');
    // Wait until state is persisted without sleeping
    {
      const options = useFileExplorerStore.persist.getOptions();
      const storage = options.storage;
      for (let i = 0; i < 100; i++) {
        const value = await storage?.getItem('file-explorer-storage-v4');
        if (value) break;
        await new Promise((resolve) => process.nextTick(resolve));
      }
    }

    const options = useFileExplorerStore.persist.getOptions();
    const stored = await options.storage?.getItem('file-explorer-storage-v4');
    expect(stored).toBeTruthy();
  });
});

describe('createFileExplorerStore with custom adapter', () => {
  it('persists state using provided adapter', async () => {
    const adapter = new MemoryStorageAdapter();
    const { createFileExplorerStore } = await import('../store');

    const store = createFileExplorerStore(adapter);
    store.getState().setCurrentFolderId('foo');
    // Wait until persisted using storage adapter without sleeping
    for (let i = 0; i < 100; i++) {
      if (adapter.getSize() > 0) break;
      await new Promise((resolve) => process.nextTick(resolve));
    }

    const newStore = createFileExplorerStore(adapter);
    await new Promise((resolve) => {
      const unsub = newStore.persist.onFinishHydration(() => {
        resolve(undefined);
        unsub();
      });
      if (newStore.persist.hasHydrated()) {
        resolve(undefined);
        unsub();
      }
    });

    expect(newStore.getState().currentFolderId).toBe('foo');
  });
});
