import { describe, expect, it, vi } from 'vitest';
import { FakeDirectoryHandle, fakeDir, fakeNote } from '../../__tests__/support/fake-handles';
import { createMemoryHandleStore } from '../../__tests__/support/memory-handle-store';
import type { StoredVaultRoot } from '../../core/handle-store';
import type { VaultDirectoryHandleLike } from '../../core/types';
import type { VaultWatcher } from '../../core/watch';
import { createNotesVaultStore, type NotesVaultServices } from '../notes-vault-store';

interface WatchRecord {
  handle: VaultDirectoryHandleLike;
  onChange: () => void;
  watcher: VaultWatcher & { disconnected: boolean };
}

interface Harness {
  handleStore: ReturnType<typeof createMemoryHandleStore>;
  services: NotesVaultServices;
  setNextPick: (dir: FakeDirectoryHandle | (() => Promise<FakeDirectoryHandle>)) => void;
  store: ReturnType<typeof createNotesVaultStore>;
  watches: WatchRecord[];
}

function harness(overrides: Partial<NotesVaultServices> = {}): Harness {
  const handleStore = createMemoryHandleStore();
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

describe('default vault', () => {
  it('mounts the built-in vault first on initialize, unpersisted and expanded', async () => {
    const h = harness({
      getDefaultVault: () =>
        Promise.resolve({
          handle: fakeDir('brainstrike-notes', [fakeNote('Welcome.md')]),
          name: 'My Notes',
        }),
    });
    await h.handleStore.put({
      addedAt: 1,
      handle: fakeDir('user-vault'),
      name: 'user-vault',
      rootId: 'u1',
    });

    await h.store.getState().initialize();

    const state = h.store.getState();
    expect(state.roots.map((root) => [root.name, root.builtIn ?? false])).toEqual([
      ['My Notes', true],
      ['user-vault', false],
    ]);
    expect(state.roots[0]).toMatchObject({ noteCount: 1, status: 'ready' });
    expect(state.expandedIds.has(state.roots[0]?.rootId ?? '')).toBe(true);
    // The built-in vault is derived each boot, never written to persistence.
    expect(h.handleStore.rows.size).toBe(1);
  });

  it('does not duplicate the built-in vault across repeated initializes', async () => {
    const h = harness({
      getDefaultVault: () =>
        Promise.resolve({ handle: fakeDir('brainstrike-notes'), name: 'My Notes' }),
    });

    await h.store.getState().initialize();
    await h.store.getState().initialize();

    expect(h.store.getState().roots).toHaveLength(1);
  });

  it('surfaces default-vault provisioning failures without blocking stored roots', async () => {
    const h = harness({
      getDefaultVault: () => Promise.reject(new Error('opfs unavailable')),
    });
    await h.handleStore.put({
      addedAt: 1,
      handle: fakeDir('user-vault', [fakeNote('a.md')]),
      name: 'user-vault',
      rootId: 'u1',
    });

    await h.store.getState().initialize();

    const state = h.store.getState();
    expect(state.globalError).toMatch(/opfs unavailable/);
    expect(state.roots.map((root) => root.name)).toEqual(['user-vault']);
  });
});

describe('built-in root protection', () => {
  it('removeRoot is a guarded no-op for the built-in default vault', async () => {
    const h = harness({
      getDefaultVault: () =>
        Promise.resolve({
          handle: fakeDir('brainstrike-notes', [fakeNote('w.md')]),
          name: 'My Notes',
        }),
    });
    await h.store.getState().initialize();
    const builtInId = h.store.getState().roots[0]?.rootId ?? '';

    await h.store.getState().removeRoot(builtInId);

    expect(h.store.getState().roots).toHaveLength(1);
    expect(h.watches[0]?.watcher.disconnected).toBe(false);
  });
});

describe('edit request handshake', () => {
  it('selectNoteForEditing selects the note and arms a one-shot edit request', async () => {
    const h = harness();
    h.setNextPick(fakeDir('vault', [fakeNote('a.md')]));
    await h.store.getState().addVaultFromPicker();

    h.store.getState().selectNoteForEditing('root-1:a.md');
    expect(h.store.getState().selectedNoteId).toBe('root-1:a.md');
    expect(h.store.getState().editRequestNoteId).toBe('root-1:a.md');

    h.store.getState().clearEditRequest();
    expect(h.store.getState().editRequestNoteId).toBeNull();
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

/** A directory whose scan blocks until release() is called. */
function gatedDir(
  name: string,
  children: readonly (ReturnType<typeof fakeNote> | FakeDirectoryHandle)[]
): { dir: FakeDirectoryHandle; release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dir = new FakeDirectoryHandle(name, children);
  let firstCall = true;
  // First scan snapshots the entries THEN blocks, so a superseding scan that
  // runs after a mutation sees fresh content while the stale scan does not.
  dir.values = async function* values() {
    const snapshot = [...dir.entries.values()];
    if (firstCall) {
      firstCall = false;
      await gate;
    }
    yield* snapshot;
  };
  return { dir, release };
}

describe('lifecycle races', () => {
  it('reset() during an in-flight initialize keeps the store empty (factory-reset contract)', async () => {
    const h = harness();
    let releaseList: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const stored = [
      { addedAt: 1, handle: fakeDir('vault', [fakeNote('a.md')]), name: 'vault', rootId: 'r1' },
    ];
    const initPromise = createNotesVaultStore({
      ...h.services,
      handleStore: {
        ...h.services.handleStore,
        list: async () => {
          await gate;
          return stored;
        },
      },
    });
    const started = initPromise.getState().initialize();
    initPromise.getState().reset();
    releaseList();
    await started;

    expect(initPromise.getState().roots).toEqual([]);
    expect(h.watches).toHaveLength(0);
  });

  it('reset() during a pending permission query cannot mount the root afterwards', async () => {
    const h = harness();
    const dir = fakeDir('vault', [fakeNote('a.md')]);
    let releaseQuery: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    dir.queryPermission = async () => {
      await gate;
      return 'granted';
    };
    await h.handleStore.put({ addedAt: 1, handle: dir, name: 'vault', rootId: 'r1' });

    const started = h.store.getState().initialize();
    // Let initialize reach the permission query, then reset mid-await.
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.store.getState().reset();
    releaseQuery();
    await started;

    expect(h.store.getState().roots).toEqual([]);
    expect(h.watches).toHaveLength(0);
  });

  it('a superseding scan wins over a slower stale one (generation guard)', async () => {
    const h = harness();
    const slow = gatedDir('vault', [fakeNote('stale.md')]);
    h.setNextPick(slow.dir as FakeDirectoryHandle);
    const mountPromise = h.store.getState().addVaultFromPicker();

    // Wait for the root row to appear (scan blocked on the gate).
    await vi.waitFor(() => {
      expect(h.store.getState().roots).toHaveLength(1);
    });
    // Supersede: unblock content swap then refresh with fresh entries.
    slow.dir.entries.set('fresh.md', fakeNote('fresh.md'));
    slow.dir.entries.delete('stale.md');
    const refresh = h.store.getState().refreshRoot('root-1');
    slow.release();
    await Promise.all([mountPromise, refresh]);

    const root = h.store.getState().roots[0];
    expect(root?.nodes.map((n) => n.name)).toEqual(['fresh.md']);
    expect(root?.status).toBe('ready');
  });

  it('removeRoot during an in-flight scan never resurrects the root', async () => {
    const h = harness();
    const slow = gatedDir('vault', [fakeNote('a.md')]);
    h.setNextPick(slow.dir as FakeDirectoryHandle);
    const mountPromise = h.store.getState().addVaultFromPicker();
    await vi.waitFor(() => {
      expect(h.store.getState().roots).toHaveLength(1);
    });

    await h.store.getState().removeRoot('root-1');
    slow.release();
    await mountPromise;

    expect(h.store.getState().roots).toEqual([]);
  });

  it('re-watching a root disconnects the previous watcher (no observer leak)', async () => {
    const h = harness();
    const locked = fakeDir('locked', [fakeNote('a.md')]);
    locked.permissionState = 'prompt';
    locked.requestOutcome = 'granted';
    await h.handleStore.put({ addedAt: 1, handle: locked, name: 'locked', rootId: 'p1' });
    await h.store.getState().initialize();

    await Promise.all([
      h.store.getState().reconnectRoot('p1'),
      h.store.getState().reconnectRoot('p1'),
    ]);

    const active = h.watches.filter((w) => !w.watcher.disconnected);
    expect(active).toHaveLength(1);
  });
});

describe('error classification and surfacing', () => {
  it('maps NotAllowedError during scan back to permission-required (keeps Reconnect)', async () => {
    const h = harness();
    const revoked = fakeDir('revoked');
    revoked.values = () => {
      throw new DOMException('permission revoked', 'NotAllowedError');
    };
    h.setNextPick(revoked);

    await h.store.getState().addVaultFromPicker();

    const root = h.store.getState().roots[0];
    expect(root?.status).toBe('permission-required');
    expect(root?.error).toMatch(/permission/i);
  });

  it('mounts remaining dropped folders when one fails, aggregating the error', async () => {
    const h = harness();
    let putCalls = 0;
    const failingServices = {
      ...h.services,
      handleStore: {
        ...h.services.handleStore,
        put: (root: StoredVaultRoot) => {
          putCalls += 1;
          if (putCalls === 1) {
            return Promise.reject(new Error('quota exceeded'));
          }
          return h.services.handleStore.put(root);
        },
      },
    };
    const store = createNotesVaultStore(failingServices);

    await store
      .getState()
      .addDroppedDirectories([fakeDir('broken'), fakeDir('good', [fakeNote('g.md')])]);

    const state = store.getState();
    expect(state.roots.map((root) => [root.name, root.status])).toEqual([['good', 'ready']]);
    expect(state.globalError).toMatch(/1 of 2/);
    expect(state.globalError).toMatch(/quota exceeded/);
  });

  it('downgrades to manual refresh when the observer fails after attach', async () => {
    const h = harness({
      createWatcher: (_handle, _onChange, onError) => {
        setTimeout(() => onError?.(new DOMException('revoked', 'NotAllowedError')), 0);
        return { disconnect: () => undefined };
      },
    });
    h.setNextPick(fakeDir('vault'));

    await h.store.getState().addVaultFromPicker();

    await vi.waitFor(() => {
      expect(h.store.getState().watchSupported).toBe(false);
    });
  });

  it('keeps initialized=false until restore has actually completed (no empty-state flash)', async () => {
    const h = harness();
    let releaseList: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const store = createNotesVaultStore({
      ...h.services,
      handleStore: {
        ...h.services.handleStore,
        list: async () => {
          await gate;
          return [];
        },
      },
    });

    const pending = store.getState().initialize();
    expect(store.getState().initialized).toBe(false);
    releaseList();
    await pending;
    expect(store.getState().initialized).toBe(true);
  });
});

describe('entry management actions', () => {
  it('createNote creates in the container and arms the editor', async () => {
    const h = harness();
    h.setNextPick(fakeDir('vault', [fakeDir('projects')]));
    await h.store.getState().addVaultFromPicker();

    await h.store.getState().createNote('root-1:projects');

    const state = h.store.getState();
    expect(state.editRequestNoteId).toBe('root-1:projects/Untitled.md');
    expect(state.selectedNoteId).toBe('root-1:projects/Untitled.md');
    const projects = state.roots[0]?.nodes.find((n) => n.name === 'projects');
    expect(
      projects?.type === 'folder' && projects.children.some((c) => c.name === 'Untitled.md')
    ).toBe(true);
  });

  async function mountedVault() {
    const h = harness();
    h.setNextPick(
      fakeDir('vault', [
        fakeDir('projects', [fakeNote('plan.md', { content: 'plan body' })]),
        fakeNote('inbox.md'),
      ])
    );
    await h.store.getState().addVaultFromPicker();
    return h;
  }

  it('creates a folder under a folder node and expands it', async () => {
    const h = await mountedVault();

    await h.store.getState().createFolder('root-1:projects', 'ideas');

    const root = h.store.getState().roots[0];
    const projects = root?.nodes.find((n) => n.name === 'projects');
    expect(projects?.type === 'folder' && projects.children.some((c) => c.name === 'ideas')).toBe(
      true
    );
    expect(h.store.getState().expandedIds.has('root-1:projects')).toBe(true);
  });

  it('creates a folder at the root level when given the root id', async () => {
    const h = await mountedVault();

    await h.store.getState().createFolder('root-1', 'top-level');

    expect(h.store.getState().roots[0]?.nodes.some((n) => n.name === 'top-level')).toBe(true);
  });

  it('renames a note and remaps the selection to the new id', async () => {
    const h = await mountedVault();
    h.store.getState().selectNote('root-1:projects/plan.md');

    await h.store.getState().renameEntry('root-1:projects/plan.md', 'roadmap.md');

    const state = h.store.getState();
    expect(state.selectedNoteId).toBe('root-1:projects/roadmap.md');
    const projects = state.roots[0]?.nodes.find((n) => n.name === 'projects');
    expect(
      projects?.type === 'folder' && projects.children.some((c) => c.name === 'roadmap.md')
    ).toBe(true);
  });

  it('renames a folder and remaps expansion + selection prefixes', async () => {
    const h = await mountedVault();
    h.store.getState().toggleExpanded('root-1:projects');
    h.store.getState().selectNote('root-1:projects/plan.md');

    await h.store.getState().renameEntry('root-1:projects', 'work');

    const state = h.store.getState();
    expect(state.expandedIds.has('root-1:work')).toBe(true);
    expect(state.expandedIds.has('root-1:projects')).toBe(false);
    expect(state.selectedNoteId).toBe('root-1:work/plan.md');
  });

  it('publishes the rename remap so open editors can rebind instead of flushing stale handles', async () => {
    const h = await mountedVault();
    expect(h.store.getState().lastRename).toBeNull();

    await h.store.getState().renameEntry('root-1:projects', 'work');

    expect(h.store.getState().lastRename).toEqual({
      from: 'root-1:projects',
      to: 'root-1:work',
    });
  });

  it('deletes an entry, pruning selection under it', async () => {
    const h = await mountedVault();
    h.store.getState().selectNote('root-1:projects/plan.md');

    await h.store.getState().deleteEntry('root-1:projects');

    const state = h.store.getState();
    expect(state.roots[0]?.nodes.some((n) => n.name === 'projects')).toBe(false);
    expect(state.selectedNoteId).toBeNull();
  });

  it('surfaces operation failures in the alert banner', async () => {
    const h = await mountedVault();

    await h.store.getState().createFolder('root-1', 'inbox.md');

    expect(h.store.getState().globalError).toMatch(/already exists/i);
  });
});
