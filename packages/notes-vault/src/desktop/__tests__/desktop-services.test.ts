import { describe, expect, it, vi } from 'vitest';
import { createMemoryHandleStore } from '../../__tests__/support/memory-handle-store';
import type { NotesVaultBridge, NotesVaultChangeEvent, NotesVaultResult } from '../bridge-contract';
import { createDesktopNotesVaultServices } from '../desktop-services';
import { createNodeVaultDirectoryHandle, nodeVaultHandlePath } from '../node-vault-handles';

function ok<T>(value: T): NotesVaultResult<T> {
  return { ok: true, value };
}

function stubBridge(overrides: Partial<NotesVaultBridge> = {}): NotesVaultBridge & {
  changeListeners: ((event: NotesVaultChangeEvent) => void)[];
  registeredRoots: string[];
  unwatched: string[];
} {
  const changeListeners: ((event: NotesVaultChangeEvent) => void)[] = [];
  const registeredRoots: string[] = [];
  const unwatched: string[] = [];
  return {
    changeListeners,
    createDirectory: () => Promise.resolve(ok(null)),
    deleteEntry: () => Promise.resolve(ok(null)),
    ensureDefaultVault: () =>
      Promise.resolve(ok({ name: 'Brainstrike Notes', path: '/docs/Brainstrike Notes' })),
    listDirectory: () => Promise.resolve(ok([])),
    onChanged: (callback: (event: NotesVaultChangeEvent) => void) => {
      changeListeners.push(callback);
      return () => {
        const index = changeListeners.indexOf(callback);
        if (index >= 0) {
          changeListeners.splice(index, 1);
        }
      };
    },
    pickDirectory: () => Promise.resolve(ok(null)),
    readFile: () => Promise.resolve(ok('')),
    registeredRoots,
    registerRoot: (path: string) => {
      registeredRoots.push(path);
      return Promise.resolve(ok({ name: path.split('/').at(-1) ?? path, path }));
    },
    rename: () => Promise.resolve(ok(null)),
    statEntry: () => Promise.resolve(ok(null)),
    unwatch: (watchId: string) => {
      unwatched.push(watchId);
      return Promise.resolve(ok(null));
    },
    unwatched,
    watch: () => Promise.resolve(ok({ watchId: 'w1' })),
    writeFile: () => Promise.resolve(ok({ lastModified: 1 })),
    ...overrides,
  };
}

describe('createDesktopNotesVaultServices', () => {
  it('maps picker cancellation to AbortError and picks to node handles', async () => {
    const bridge = stubBridge();
    const services = createDesktopNotesVaultServices(bridge, {
      handleStore: createMemoryHandleStore(),
    });

    await expect(services.pickDirectory()).rejects.toMatchObject({ name: 'AbortError' });

    bridge.pickDirectory = () => Promise.resolve(ok({ name: 'my-notes', path: '/home/my-notes' }));
    const handle = await services.pickDirectory();
    expect(handle.name).toBe('my-notes');
    expect(nodeVaultHandlePath(handle)).toBe('/home/my-notes');
  });

  it('provisions the default vault through the bridge', async () => {
    const services = createDesktopNotesVaultServices(stubBridge(), {
      handleStore: createMemoryHandleStore(),
    });

    const vault = await services.getDefaultVault?.();

    expect(vault?.name).toBe('Brainstrike Notes');
    expect(nodeVaultHandlePath(vault?.handle ?? ({} as never))).toBe('/docs/Brainstrike Notes');
  });

  it('persists node handles as path markers and rehydrates them with re-approval', async () => {
    const bridge = stubBridge();
    const inner = createMemoryHandleStore();
    const services = createDesktopNotesVaultServices(bridge, { handleStore: inner });
    const handle = createNodeVaultDirectoryHandle(bridge, '/home/vault', 'vault');

    await services.handleStore.put({ addedAt: 1, handle, name: 'vault', rootId: 'r1' });

    // What hit IndexedDB is a structured-cloneable marker, not a class instance.
    const persisted = inner.rows.get('r1');
    expect(persisted?.handle).toEqual({ notesVaultNodePath: '/home/vault' });

    const restored = await services.handleStore.list();
    expect(nodeVaultHandlePath(restored[0]?.handle ?? ({} as never))).toBe('/home/vault');
    // Restored roots are re-approved with main for containment.
    expect(bridge.registeredRoots).toContain('/home/vault');
  });

  it('wires watching through the bridge with id-filtered change events', async () => {
    const bridge = stubBridge();
    const services = createDesktopNotesVaultServices(bridge, {
      handleStore: createMemoryHandleStore(),
    });
    const handle = createNodeVaultDirectoryHandle(bridge, '/home/vault', 'vault');
    const onChange = vi.fn();

    const watcher = services.createWatcher(handle, onChange, vi.fn());
    expect(watcher).not.toBeNull();
    await vi.waitFor(() => {
      expect(bridge.changeListeners.length).toBeGreaterThan(0);
    });

    for (const listener of bridge.changeListeners) {
      listener({ watchId: 'other' });
    }
    expect(onChange).not.toHaveBeenCalled();
    for (const listener of bridge.changeListeners) {
      listener({ watchId: 'w1' });
    }
    expect(onChange).toHaveBeenCalledTimes(1);

    watcher?.disconnect();
    expect(bridge.unwatched).toEqual(['w1']);
    expect(bridge.changeListeners).toHaveLength(0);
  });

  it('routes watch failures to onError instead of pretending to watch', async () => {
    const bridge = stubBridge({
      watch: () => Promise.resolve({ error: 'watcher backend exploded', ok: false }),
    });
    const services = createDesktopNotesVaultServices(bridge, {
      handleStore: createMemoryHandleStore(),
    });
    const handle = createNodeVaultDirectoryHandle(bridge, '/home/vault', 'vault');
    const onError = vi.fn();

    services.createWatcher(handle, vi.fn(), onError);

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalled();
    });
    const error = onError.mock.calls[0]?.[0] as Error;
    expect(error.message).toMatch(/watcher backend/);
  });
});
