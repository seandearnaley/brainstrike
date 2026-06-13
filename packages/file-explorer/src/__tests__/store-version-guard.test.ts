import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FILE_EXPLORER_STORAGE_VERSION } from '../persistence/persistence-constants';

describe('store version/type guard', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('recreates store if a stale/invalid instance is on globalThis', async () => {
    // Inject an invalid placeholder into the global cache key
    (globalThis as any).__brainstrike_file_explorer_store__ = { foo: 'bar' };

    const mod = await import('../store');
    const store = mod.useFileExplorerStore;

    // Should be a bound Zustand store with getState/setState
    expect(typeof store).toBe('function');
    const anyStore = store as any;
    expect(typeof anyStore.getState).toBe('function');
    expect(typeof anyStore.setState).toBe('function');

    // And it should not be the dummy object
    expect(anyStore.foo).toBeUndefined();
  });

  it('FILE_EXPLORER_STORAGE_VERSION is pinned at 5 (storage v5 root identity re-key)', () => {
    // This assertion intentionally pins the version to catch accidental bumps.
    // The v4→v5 bump is intentional: currentFolderId/folderStates keys/composite
    // folderId all become RootId UUIDs (not paths) as of phase 5 root identity.
    expect(FILE_EXPLORER_STORAGE_VERSION).toBe(5);
  });
});
