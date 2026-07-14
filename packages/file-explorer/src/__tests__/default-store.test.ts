import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StateStorage } from 'zustand/middleware';

// Ensure fresh module import for each test
beforeEach(() => {
  vi.resetModules();
  // Ensure localStorage is actually undefined for this test
  (globalThis as unknown as { localStorage?: unknown }).localStorage = undefined;
  // CRITICAL: Clear the store singleton cache
  (globalThis as unknown as Record<string, unknown>)['__brainstrike_file_explorer_store__'] =
    undefined;
});

describe('default store creation without localStorage', () => {
  it('uses MemoryStorageAdapter when localStorage is unavailable', async () => {
    // Verify localStorage is actually undefined
    expect((globalThis as unknown as { localStorage?: unknown }).localStorage).toBeUndefined();

    const mod = await import('../store');
    const { useFileExplorerStore } = mod;

    // Test that the store uses MemoryStorageAdapter when localStorage is unavailable
    const options = useFileExplorerStore.persist.getOptions();
    expect(options.storage).toBeDefined();
    // The persist storage is a string-based wrapper at runtime (see
    // createStorageWrapper); type it as StateStorage to exercise it directly.
    const storage = options.storage as unknown as StateStorage | undefined;

    // Test that we can directly use the storage
    const testKey = 'test-memory-key';
    const testValue = { folder: 'test-folder' };
    const serializedValue = JSON.stringify(testValue);

    await storage?.setItem(testKey, serializedValue);
    const retrieved = await storage?.getItem(testKey);

    expect(retrieved).toEqual(serializedValue);
    expect(JSON.parse(retrieved || '{}')).toEqual(testValue);

    // Test that setting state works
    useFileExplorerStore.getState().setCurrentFolderId('foo');
    expect(useFileExplorerStore.getState().currentFolderId).toBe('foo');
  });
});
