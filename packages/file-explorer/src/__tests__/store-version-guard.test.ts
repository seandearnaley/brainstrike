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

  it('FILE_EXPLORER_STORAGE_VERSION is pinned at 4 (storage v4 greenfield reset)', () => {
    // This assertion intentionally pins the version to catch accidental bumps.
    // The v3→v4 bump was intentional (phase 4 forest-UI greenfield reset).
    expect(FILE_EXPLORER_STORAGE_VERSION).toBe(4);
  });
});
