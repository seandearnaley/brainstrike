import { describe, expect, it, vi } from 'vitest';
import { type FakeDirectoryHandle, fakeDir, fakeNote } from '../../__tests__/support/fake-handles';
import type { StoredVaultRoot, VaultHandleStore } from '../../core/handle-store';
import type { VaultDirectoryHandleLike } from '../../core/types';
import type { VaultWatcher } from '../../core/watch';
import { createNotesVaultStore, type NotesVaultServices } from '../notes-vault-store';

interface WatchRecord {
  handle: VaultDirectoryHandleLike;
  onChange: () => void;
  watcher: VaultWatcher & { disconnected: boolean };
}

function memoryHandleStore(): VaultHandleStore & { rows: Map<string, StoredVaultRoot> } {
  const rows = new Map<string, StoredVaultRoot>();
  return {
    list: () => Promise.resolve([...rows.values()].sort((a, b) => a.addedAt - b.addedAt)),
    put: (root) => {
      rows.set(root.rootId, root);
      return Promise.resolve();
    },
    remove: (rootId) => {
      rows.delete(rootId);
      return Promise.resolve();
    },
    rows,
  };
}

interface Harness {
  handleStore: ReturnType<typeof memoryHandleStore>;
  services: NotesVaultServices;
  setNextPick: (dir: FakeDirectoryHandle | (() => Promise<FakeDirectoryHandle>)) => void;
  store: ReturnType<typeof createNotesVaultStore>;
  watches: WatchRecord[];
}

function harness(overrides: Partial<NotesVaultServices> = {}): Harness {
  const handleStore = memoryHandleStore();
  const watches: WatchRecord[] = [];
  let nextPick: () => Promise<FakeDirectoryHandle> = () =>
    Promise.reject(new DOMException('canceled', 'AbortError'));
  let idCounter = 0;
  const services: NotesVaultServices = {
    createWatcher: (handle, onChange) => {
      const watcher = {
        disconnect(): void {
          this.disconnected = true;
        },
        disconnected: false,
      };
      watches.push({ handle, onChange, watcher });
      return watcher;
    },
    handleStore,
    newRootId: () => `root-${++idCounter}`,
    now: () => 1000 + idCounter,
    pickDirectory: () => nextPick(),
    rescanDebounceMs: 0,
    ...overrides,
  };
  return {
    handleStore,
    services,
    setNextPick: (dir) => {
      nextPick = typeof dir === 'function' ? dir : () => Promise.resolve(dir);
    },
    store: createNotesVaultStore(services),
    watches,
  };
}

describe('notes-vault-store', () => {
  it('mounts a picked vault: persists the handle, scans, watches, and expands the root', async () => {
    const h = harness();
    h.setNextPick(fakeDir('my-vault', [fakeNote('a.md'), fakeDir('sub', [fakeNote('b.md')])]));

    await h.store.getState().addVaultFromPicker();

    const state = h.store.getState();
    expect(state.roots).toHaveLength(1);
    expect(state.roots[0]).toMatchObject({
      name: 'my-vault',
      noteCount: 2,
      rootId: 'root-1',
      status: 'ready',
    });
    expect(h.handleStore.rows.has('root-1')).toBe(true);
    expect(h.watches).toHaveLength(1);
    expect(state.expandedIds.has('root-1')).toBe(true);
  });

  it('treats picker cancellation as a no-op, not an error', async () => {
    const h = harness();

    await h.store.getState().addVaultFromPicker();

    expect(h.store.getState().roots).toEqual([]);
    expect(h.store.getState().globalError).toBeNull();
  });

  it('surfaces picker failures as a visible global error (no silent fallback)', async () => {
    const h = harness();
    h.setNextPick(() => Promise.reject(new Error('picker exploded')));

    await h.store.getState().addVaultFromPicker();

    expect(h.store.getState().globalError).toMatch(/picker exploded/);
  });

  it('re-picking an already-mounted folder selects it instead of duplicating', async () => {
    const h = harness();
    const dir = fakeDir('vault');
    h.setNextPick(dir);
    await h.store.getState().addVaultFromPicker();
    h.setNextPick(dir);

    await h.store.getState().addVaultFromPicker();

    expect(h.store.getState().roots).toHaveLength(1);
  });

  it('mounts dropped directories as new vault roots', async () => {
    const h = harness();

    await h.store
      .getState()
      .addDroppedDirectories([fakeDir('dropped-a', [fakeNote('x.md')]), fakeDir('dropped-b')]);

    const state = h.store.getState();
    expect(state.roots.map((root) => root.name)).toEqual(['dropped-a', 'dropped-b']);
    expect(state.roots.every((root) => root.status === 'ready')).toBe(true);
  });

  it('restores persisted roots on initialize, honoring permission state', async () => {
    const h = harness();
    const granted = fakeDir('granted-vault', [fakeNote('g.md')]);
    const needsPrompt = fakeDir('locked-vault');
    needsPrompt.permissionState = 'prompt';
    await h.handleStore.put({ addedAt: 1, handle: granted, name: 'granted-vault', rootId: 'g1' });
    await h.handleStore.put({
      addedAt: 2,
      handle: needsPrompt,
      name: 'locked-vault',
      rootId: 'p1',
    });

    await h.store.getState().initialize();

    const state = h.store.getState();
    expect(state.initialized).toBe(true);
    expect(state.roots.map((root) => [root.rootId, root.status])).toEqual([
      ['g1', 'ready'],
      ['p1', 'permission-required'],
    ]);
    expect(state.roots[0]?.noteCount).toBe(1);
    expect(h.watches.map((w) => w.handle.name)).toEqual(['granted-vault']);
  });

  it('reconnectRoot prompts and scans on grant; keeps the root locked on denial', async () => {
    const h = harness();
    const locked = fakeDir('locked', [fakeNote('inside.md')]);
    locked.permissionState = 'prompt';
    locked.requestOutcome = 'granted';
    await h.handleStore.put({ addedAt: 1, handle: locked, name: 'locked', rootId: 'p1' });
    await h.store.getState().initialize();

    await h.store.getState().reconnectRoot('p1');
    expect(h.store.getState().roots[0]).toMatchObject({ noteCount: 1, status: 'ready' });

    const denied = fakeDir('denied');
    denied.permissionState = 'prompt';
    denied.requestOutcome = 'denied';
    await h.handleStore.put({ addedAt: 2, handle: denied, name: 'denied', rootId: 'p2' });
    await h.store.getState().initialize();
    await h.store.getState().reconnectRoot('p2');
    const deniedRoot = h.store.getState().roots.find((root) => root.rootId === 'p2');
    expect(deniedRoot?.status).toBe('permission-required');
    expect(deniedRoot?.error).toMatch(/denied/i);
  });

  it('removeRoot disconnects the watcher, forgets persistence, and prunes selection', async () => {
    const h = harness();
    h.setNextPick(fakeDir('vault', [fakeNote('a.md')]));
    await h.store.getState().addVaultFromPicker();
    h.store.getState().selectNote('root-1:a.md');

    await h.store.getState().removeRoot('root-1');

    expect(h.store.getState().roots).toEqual([]);
    expect(h.handleStore.rows.size).toBe(0);
    expect(h.watches[0]?.watcher.disconnected).toBe(true);
    expect(h.store.getState().selectedNoteId).toBeNull();
  });

  it('rescans a root when its watcher reports changes', async () => {
    const h = harness();
    const dir = fakeDir('vault', [fakeNote('a.md')]);
    h.setNextPick(dir);
    await h.store.getState().addVaultFromPicker();
    expect(h.store.getState().roots[0]?.noteCount).toBe(1);

    dir.entries.set('b.md', fakeNote('b.md'));
    h.watches[0]?.onChange();

    await vi.waitFor(() => {
      expect(h.store.getState().roots[0]?.noteCount).toBe(2);
    });
  });

  it('flags watchSupported=false when the observer capability is absent', async () => {
    const h = harness({ createWatcher: () => null });
    h.setNextPick(fakeDir('vault'));

    await h.store.getState().addVaultFromPicker();

    expect(h.store.getState().watchSupported).toBe(false);
  });

  it('marks a root as errored when scanning throws', async () => {
    const h = harness();
    const broken = fakeDir('broken');
    broken.values = () => {
      throw new Error('disk detached');
    };
    h.setNextPick(broken);

    await h.store.getState().addVaultFromPicker();

    expect(h.store.getState().roots[0]).toMatchObject({ status: 'error' });
    expect(h.store.getState().roots[0]?.error).toMatch(/disk detached/);
  });

  it('reset clears session state and disconnects watchers without touching persistence', async () => {
    const h = harness();
    h.setNextPick(fakeDir('vault', [fakeNote('a.md')]));
    await h.store.getState().addVaultFromPicker();

    h.store.getState().reset();

    expect(h.store.getState().roots).toEqual([]);
    expect(h.store.getState().initialized).toBe(false);
    expect(h.watches[0]?.watcher.disconnected).toBe(true);
    expect(h.handleStore.rows.size).toBe(1);
  });

  it('sort mode and expansion are plain session state', async () => {
    const h = harness();
    h.setNextPick(fakeDir('vault', [fakeDir('sub')]));
    await h.store.getState().addVaultFromPicker();

    h.store.getState().setSortMode('modified-desc');
    h.store.getState().toggleExpanded('root-1:sub');
    expect(h.store.getState().sortMode).toBe('modified-desc');
    expect(h.store.getState().expandedIds.has('root-1:sub')).toBe(true);
    h.store.getState().toggleExpanded('root-1:sub');
    expect(h.store.getState().expandedIds.has('root-1:sub')).toBe(false);
  });
});

describe('initialize concurrency', () => {
  it('coalesces concurrent initialize calls so each stored root mounts once (StrictMode)', async () => {
    const h = harness();
    await h.handleStore.put({
      addedAt: 1,
      handle: fakeDir('vault', [fakeNote('a.md')]),
      name: 'vault',
      rootId: 'r1',
    });

    await Promise.all([h.store.getState().initialize(), h.store.getState().initialize()]);

    expect(h.store.getState().roots).toHaveLength(1);
    expect(h.watches).toHaveLength(1);
  });
});
