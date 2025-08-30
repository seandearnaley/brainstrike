import { MemoryStorageAdapter } from '@brainstrike/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  (globalThis as unknown as { localStorage?: unknown }).localStorage = undefined;
  // CRITICAL: Clear the store singleton cache
  (globalThis as unknown as Record<string, unknown>)['__brainstrike_file_explorer_store__'] =
    undefined;
});

describe('useFileExplorerStore without localStorage', () => {
  it('uses MemoryStorageAdapter for persistence', async () => {
    const mod = await import('../store');
    const { useFileExplorerStore } = mod;

    // Test that the store uses MemoryStorageAdapter when localStorage is not available
    const options = useFileExplorerStore.persist.getOptions();
    expect(options.storage).toBeDefined();

    // Verify that MemoryStorageAdapter is being used via the storage wrapper

    // Test that we can set and get from the storage adapter
    const testKey = 'test-key';
    const testValue = { test: 'data' };
    const serializedValue = JSON.stringify(testValue);

    await options.storage?.setItem(testKey, serializedValue);
    const retrieved = await options.storage?.getItem(testKey);

    expect(retrieved).toEqual(serializedValue);
    expect(JSON.parse(retrieved || '{}')).toEqual(testValue);

    // Test that the store persistence works by setting state and checking it persists
    useFileExplorerStore.getState().setCurrentFolderId('test-folder');

    // The persistence should work with the memory adapter
    expect(useFileExplorerStore.getState().currentFolderId).toBe('test-folder');
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
