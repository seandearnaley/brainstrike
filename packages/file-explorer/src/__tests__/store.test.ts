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
    await new Promise((r) => setTimeout(r, 250));

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
    await new Promise((r) => setTimeout(r, 250));

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
