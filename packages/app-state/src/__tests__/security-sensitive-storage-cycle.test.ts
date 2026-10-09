import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StateStorage } from 'zustand/middleware';

interface PersistApi {
  readonly hasHydrated: () => boolean;
  readonly rehydrate: () => Promise<void> | void;
}

function createMemoryStorage(): StateStorage<void> {
  const values = new Map<string, string>();
  return {
    getItem: (name) => values.get(name) ?? null,
    removeItem: (name) => {
      values.delete(name);
    },
    setItem: (name, value) => {
      values.set(name, value);
    },
  };
}

async function installTransientStorageFailure(): Promise<ReturnType<typeof vi.fn>> {
  const memoryStorage = createMemoryStorage();
  const createBrowserJsonStorage = vi
    .fn<() => StateStorage<void>>()
    .mockImplementationOnce(() => {
      throw new Error('storage chunk is still evaluating');
    })
    .mockReturnValue(memoryStorage);

  vi.doMock('@brainstrike/storage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@brainstrike/storage')>();
    return { ...actual, createBrowserJsonStorage };
  });

  return createBrowserJsonStorage;
}

describe('security-sensitive store persistence during chunk evaluation', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('@brainstrike/storage');
  });

  it('keeps permission-policy persistence installed and retries a transient resolution failure', async () => {
    const createBrowserJsonStorage = await installTransientStorageFailure();
    const { usePermissionPolicyStore } = await import('../stores/permission-policy-store');
    const persist = (
      usePermissionPolicyStore as typeof usePermissionPolicyStore & {
        persist?: PersistApi;
      }
    ).persist;

    expect(persist).toBeDefined();
    expect(createBrowserJsonStorage).toHaveBeenCalledOnce();

    await persist?.rehydrate();

    expect(createBrowserJsonStorage).toHaveBeenCalledTimes(2);
    expect(persist?.hasHydrated()).toBe(true);
  });
});
