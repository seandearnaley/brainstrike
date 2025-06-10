import { MemoryStorageAdapter } from '@brainstrike/storage';
import { beforeEach, describe, expect, it } from 'vitest';

beforeEach(() => {
  (globalThis as unknown as { localStorage?: unknown }).localStorage = undefined;
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
