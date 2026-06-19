import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPersistentUiState } from '../settings/system/factory-reset-helpers';
import {
  __resetPermissionPolicyStoreForTests,
  usePermissionPolicyStore,
} from '../stores/permission-policy-store';

const globalWindow = window as Window &
  typeof globalThis & {
    caches?: CacheStorage;
  };

describe('factory reset wires the permission policy store', () => {
  let originalCaches: CacheStorage | undefined;

  beforeEach(() => {
    __resetPermissionPolicyStoreForTests();
    originalCaches = globalWindow.caches;
    // An empty CacheStorage keeps clearPersistentUiState from throwing on the
    // cache-verification path; this test only cares about the store reset.
    Object.defineProperty(globalWindow, 'caches', {
      configurable: true,
      value: {
        keys: async () => [] as string[],
        delete: async () => true,
      } as unknown as CacheStorage,
    });
  });

  afterEach(() => {
    if (originalCaches) {
      Object.defineProperty(globalWindow, 'caches', { configurable: true, value: originalCaches });
    } else {
      Reflect.deleteProperty(globalWindow, 'caches');
    }
    __resetPermissionPolicyStoreForTests();
  });

  it('resets in-memory policy state and session grants during clearPersistentUiState', async () => {
    const store = usePermissionPolicyStore.getState();
    store.setEnforce(true);
    store.setYolo(true);
    store.setCategoryPolicy('edit', 'deny');
    store.grantSessionCategory('execute');
    store.setToolOverride('brainstrike.tool', 'allow');

    await clearPersistentUiState({ skipIndexedDb: true });

    const state = usePermissionPolicyStore.getState();
    expect(state.enforce).toBe(false);
    expect(state.yolo).toBe(false);
    expect(state.policies).toEqual({ read: 'allow', edit: 'ask', execute: 'ask', mcp: 'allow' });
    expect(state.sessionGrants.size).toBe(0);
    expect(state.perToolOverrides).toEqual({});
  });
});
