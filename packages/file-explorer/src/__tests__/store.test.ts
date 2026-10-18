import { createMemoryStorageAdapter, MemoryStorageAdapter } from '@brainstrike/storage';
import type { StoredRootDescriptor } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StateStorage } from 'zustand/middleware';

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
    // The persist storage is a string-based wrapper at runtime (see
    // createStorageWrapper); type it as StateStorage to exercise it directly.
    const storage = options.storage as unknown as StateStorage | undefined;

    // Verify that MemoryStorageAdapter is being used via the storage wrapper

    // Test that we can set and get from the storage adapter
    const testKey = 'test-key';
    const testValue = { test: 'data' };
    const serializedValue = JSON.stringify(testValue);

    await storage?.setItem(testKey, serializedValue);
    const retrieved = await storage?.getItem(testKey);

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
      if (adapter.getSize() > 0) {
        break;
      }
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

// ============================================================================
// Active roots store tests (Task 1: Phase 4 multi-root)
// These tests use async dynamic imports to respect vi.resetModules() from
// the file-level beforeEach.
// ============================================================================

describe('active roots — setActiveRoots', () => {
  it('initialises with empty activeRootIds and rootDescriptors', async () => {
    const { createFileExplorerStore } = await import('../store');
    const store = createFileExplorerStore(createMemoryStorageAdapter());
    const state = store.getState();
    expect(state.activeRootIds).toEqual([]);
    expect(state.rootDescriptors).toEqual({});
  });

  it('setActiveRoots replaces both fields atomically', async () => {
    const { createFileExplorerStore } = await import('../store');
    const store = createFileExplorerStore(createMemoryStorageAdapter());
    const roots: StoredRootDescriptor[] = [
      { displayName: 'Project A', path: '/home/user/project-a', rootId: 'root-1' },
      { displayName: 'Project B', path: '/home/user/project-b', rootId: 'root-2' },
    ];

    store.getState().setActiveRoots(roots);

    const state = store.getState();
    expect(state.activeRootIds).toEqual(['root-1', 'root-2']);
    expect(state.rootDescriptors).toEqual({
      'root-1': { displayName: 'Project A', path: '/home/user/project-a', rootId: 'root-1' },
      'root-2': { displayName: 'Project B', path: '/home/user/project-b', rootId: 'root-2' },
    });
  });

  it('setActiveRoots replaces previous state fully', async () => {
    const { createFileExplorerStore } = await import('../store');
    const store = createFileExplorerStore(createMemoryStorageAdapter());
    store.getState().setActiveRoots([{ displayName: 'Old', path: '/old', rootId: 'old-root' }]);
    store.getState().setActiveRoots([{ displayName: 'New', path: '/new', rootId: 'new-root' }]);

    const state = store.getState();
    expect(state.activeRootIds).toEqual(['new-root']);
    expect(Object.keys(state.rootDescriptors)).toEqual(['new-root']);
    expect(state.rootDescriptors['old-root']).toBeUndefined();
  });

  it('setActiveRoots with empty array clears both fields', async () => {
    const { createFileExplorerStore } = await import('../store');
    const store = createFileExplorerStore(createMemoryStorageAdapter());
    store.getState().setActiveRoots([{ displayName: 'A', path: '/a', rootId: 'root-1' }]);
    store.getState().setActiveRoots([]);

    const state = store.getState();
    expect(state.activeRootIds).toEqual([]);
    expect(state.rootDescriptors).toEqual({});
  });

  it('setActiveRoots preserves insertion order in activeRootIds', async () => {
    const { createFileExplorerStore } = await import('../store');
    const store = createFileExplorerStore(createMemoryStorageAdapter());
    const roots: StoredRootDescriptor[] = [
      { displayName: 'C', path: '/c', rootId: 'c' },
      { displayName: 'A', path: '/a', rootId: 'a' },
      { displayName: 'B', path: '/b', rootId: 'b' },
    ];
    store.getState().setActiveRoots(roots);
    expect(store.getState().activeRootIds).toEqual(['c', 'a', 'b']);
  });
});

describe('active roots — addActiveRoot', () => {
  it('appends a new root to activeRootIds and rootDescriptors', async () => {
    const { createFileExplorerStore } = await import('../store');
    const store = createFileExplorerStore(createMemoryStorageAdapter());
    store.getState().addActiveRoot({ displayName: 'A', path: '/a', rootId: 'root-1' });

    const state = store.getState();
    expect(state.activeRootIds).toEqual(['root-1']);
    expect(state.rootDescriptors['root-1']).toEqual({
      displayName: 'A',
      path: '/a',
      rootId: 'root-1',
    });
  });

  it('appends multiple roots in order', async () => {
    const { createFileExplorerStore } = await import('../store');
    const store = createFileExplorerStore(createMemoryStorageAdapter());
    store.getState().addActiveRoot({ displayName: 'R1', path: '/r1', rootId: 'r1' });
    store.getState().addActiveRoot({ displayName: 'R2', path: '/r2', rootId: 'r2' });

    expect(store.getState().activeRootIds).toEqual(['r1', 'r2']);
  });

  it('is a no-op for duplicate rootId (does not append again)', async () => {
    const { createFileExplorerStore } = await import('../store');
    const store = createFileExplorerStore(createMemoryStorageAdapter());
    store.getState().addActiveRoot({ displayName: 'A', path: '/a', rootId: 'root-1' });
    store.getState().addActiveRoot({ displayName: 'A', path: '/a', rootId: 'root-1' });

    expect(store.getState().activeRootIds).toEqual(['root-1']);
  });

  it('updates the descriptor record when re-adding an existing rootId', async () => {
    const { createFileExplorerStore } = await import('../store');
    const store = createFileExplorerStore(createMemoryStorageAdapter());
    store.getState().addActiveRoot({ displayName: 'Old Name', path: '/old', rootId: 'root-1' });
    store.getState().addActiveRoot({ displayName: 'New Name', path: '/new', rootId: 'root-1' });

    const state = store.getState();
    // activeRootIds still has one entry (no duplicate append)
    expect(state.activeRootIds).toEqual(['root-1']);
    // descriptor is refreshed with new values
    expect(state.rootDescriptors['root-1']).toEqual({
      displayName: 'New Name',
      path: '/new',
      rootId: 'root-1',
    });
  });
});

describe('active roots — removeActiveRoot (disconnect)', () => {
  it('purges activeRootIds, rootDescriptors, folderStates, and folderAccessOrder atomically', async () => {
    const { createFileExplorerStore } = await import('../store');
    const store = createFileExplorerStore(createMemoryStorageAdapter());
    store.getState().addActiveRoot({ displayName: 'A', path: '/a', rootId: 'root-1' });
    store.getState().addActiveRoot({ displayName: 'B', path: '/b', rootId: 'root-2' });
    // Seed folderStates + folderAccessOrder entries for both roots.
    store.getState().setCurrentFolderId('root-1');
    store.getState().setCurrentFolderId('root-2');
    expect(store.getState().folderStates['root-1']).toBeDefined();
    expect(store.getState().folderAccessOrder).toContain('root-1');

    // Atomic: zustand notifies subscribers once per set() — the whole purge
    // must arrive as exactly one notification.
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.getState().removeActiveRoot('root-1');
    unsubscribe();

    const state = store.getState();
    expect(state.activeRootIds).toEqual(['root-2']);
    expect(state.rootDescriptors['root-1']).toBeUndefined();
    expect(state.folderStates['root-1']).toBeUndefined();
    expect(state.folderAccessOrder).not.toContain('root-1');
    expect(notifications).toBe(1);
  });

  it('leaves the other roots fully intact', async () => {
    const { createFileExplorerStore } = await import('../store');
    const store = createFileExplorerStore(createMemoryStorageAdapter());
    store.getState().addActiveRoot({ displayName: 'A', path: '/a', rootId: 'root-1' });
    store.getState().addActiveRoot({ displayName: 'B', path: '/b', rootId: 'root-2' });
    store.getState().setCurrentFolderId('root-2');

    store.getState().removeActiveRoot('root-1');

    const state = store.getState();
    expect(state.activeRootIds).toEqual(['root-2']);
    expect(state.rootDescriptors['root-2']).toEqual({
      displayName: 'B',
      path: '/b',
      rootId: 'root-2',
    });
    expect(state.folderStates['root-2']).toBeDefined();
    expect(state.folderAccessOrder).toContain('root-2');
  });

  it('is a safe no-op for an unknown rootId', async () => {
    const { createFileExplorerStore } = await import('../store');
    const store = createFileExplorerStore(createMemoryStorageAdapter());
    store.getState().addActiveRoot({ displayName: 'A', path: '/a', rootId: 'root-1' });

    store.getState().removeActiveRoot('does-not-exist');

    const state = store.getState();
    expect(state.activeRootIds).toEqual(['root-1']);
    expect(state.rootDescriptors['root-1']).toBeDefined();
  });

  it('does not touch currentFolderId (focus shift is the hook layer responsibility)', async () => {
    const { createFileExplorerStore } = await import('../store');
    const store = createFileExplorerStore(createMemoryStorageAdapter());
    store.getState().addActiveRoot({ displayName: 'A', path: '/a', rootId: 'root-1' });
    store.getState().setCurrentFolderId('root-1');

    store.getState().removeActiveRoot('root-1');

    expect(store.getState().currentFolderId).toBe('root-1');
  });
});

describe('active roots — persist round-trip', () => {
  it('activeRootIds and rootDescriptors survive a serialize/rehydrate cycle', async () => {
    const adapter = new MemoryStorageAdapter();
    const { createFileExplorerStore } = await import('../store');

    const store1 = createFileExplorerStore(adapter);
    const roots: StoredRootDescriptor[] = [
      { displayName: 'RT Project', path: '/rt/project', rootId: 'rt-root' },
    ];
    store1.getState().setActiveRoots(roots);

    // Wait for persist to flush
    for (let i = 0; i < 100; i++) {
      if (adapter.getSize() > 0) {
        break;
      }
      await new Promise((resolve) => process.nextTick(resolve));
    }

    const store2 = createFileExplorerStore(adapter);
    await new Promise<void>((resolve) => {
      const unsub = store2.persist.onFinishHydration(() => {
        resolve();
        unsub();
      });
      if (store2.persist.hasHydrated()) {
        resolve();
        unsub();
      }
    });

    const state = store2.getState();
    expect(state.activeRootIds).toEqual(['rt-root']);
    expect(state.rootDescriptors['rt-root']).toEqual({
      displayName: 'RT Project',
      path: '/rt/project',
      rootId: 'rt-root',
    });
  });
});

describe('expansions across focus changes (BST-2088)', () => {
  it('re-mounting a root after its view was retired restores the expansions that view saved', async () => {
    const { createFileExplorerStore } = await import('../store');
    const store = createFileExplorerStore(createMemoryStorageAdapter());
    store.getState().setCurrentFolderId('root-1');
    store.getState().setExpandedPaths(new Set(['src', 'src/lib']));

    // An empty boot restore (or a web folder awaiting permission) retires the view.
    store.getState().setCurrentFolderId(null);
    expect(store.getState().expandedDirectoryPaths.size).toBe(0);

    store.getState().setCurrentFolderId('root-1');
    expect(store.getState().expandedDirectoryPaths).toEqual(new Set(['src', 'src/lib']));
  });

  it('switching focus between mounted roots keeps the workspace-global expansions', async () => {
    const { createFileExplorerStore } = await import('../store');
    const store = createFileExplorerStore(createMemoryStorageAdapter());
    store.getState().setCurrentFolderId('root-1');
    store.getState().setExpandedPaths(new Set(['a']));
    store.getState().setCurrentFolderId('root-2');
    store.getState().setExpandedPaths(new Set(['a', 'b']));

    // root-1's snapshot holds only 'a'; focusing it must not collapse 'b'.
    store.getState().setCurrentFolderId('root-1');
    expect(store.getState().expandedDirectoryPaths).toEqual(new Set(['a', 'b']));
  });

  it('a retired view that someone expanded since is not overwritten by the snapshot', async () => {
    const { createFileExplorerStore } = await import('../store');
    const store = createFileExplorerStore(createMemoryStorageAdapter());
    store.getState().setCurrentFolderId('root-1');
    store.getState().setExpandedPaths(new Set(['old']));
    store.getState().setCurrentFolderId(null);
    store.getState().setExpandedPaths(new Set(['current']));

    store.getState().setCurrentFolderId('root-1');
    expect(store.getState().expandedDirectoryPaths).toEqual(new Set(['current']));
  });
});
