import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('store version/type guard', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('recreates store if a stale/invalid instance is on globalThis', async () => {
    // Inject an invalid placeholder into the global cache key
    // biome-ignore lint/suspicious/noExplicitAny: test-time global mutation
    (globalThis as any).__brainstrike_file_explorer_store__ = { foo: 'bar' };

    const mod = await import('../store');
    const store = mod.useFileExplorerStore;

    // Should be a bound Zustand store with getState/setState
    expect(typeof store).toBe('function');
    // biome-ignore lint/suspicious/noExplicitAny: testing API shape
    const anyStore = store as any;
    expect(typeof anyStore.getState).toBe('function');
    expect(typeof anyStore.setState).toBe('function');

    // And it should not be the dummy object
    expect(anyStore.foo).toBeUndefined();
  });
});
