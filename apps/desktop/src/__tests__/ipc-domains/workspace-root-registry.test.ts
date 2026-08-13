import path from 'node:path';
import type { DirectoryHandle } from '@brainstrike/file-system';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRootsQueryable } from '../../assistant-server/workspace-roots';
import {
  type SecureWorkspaceRoot,
  WorkspaceRootRegistry,
} from '../../ipc-domains/workspace-root-registry';

function createStorage(initial: Record<string, string> = {}): ElectronStorageAdapter {
  const values = new Map(Object.entries(initial));
  return {
    clear: vi.fn(async () => values.clear()),
    getAllKeys: vi.fn(async () => [...values.keys()]),
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  } as unknown as ElectronStorageAdapter;
}

function rootHandle(rootPath: string): DirectoryHandle {
  return {
    kind: 'directory',
    name: path.basename(rootPath),
    path: rootPath,
    platform: 'electron',
  };
}

function secureRoot(canonicalPath: string): SecureWorkspaceRoot {
  return {
    canonicalPath,
    close: vi.fn(),
    listDir: vi.fn(async () => ({ entries: [], inspected: 0, truncated: false })),
    readFile: vi.fn(async () => ({ content: Buffer.from('inside'), status: 'ok' as const })),
  };
}

describe('WorkspaceRootRegistry', () => {
  let dbQuery: ReturnType<typeof vi.fn>;
  let storage: ElectronStorageAdapter;

  beforeEach(() => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    storage = createStorage();
  });

  function createRegistry(
    overrides: Partial<ConstructorParameters<typeof WorkspaceRootRegistry>[0]> = {}
  ): WorkspaceRootRegistry {
    const db = { query: dbQuery } as unknown as WorkspaceRootsQueryable;
    return new WorkspaceRootRegistry({
      createSecureRoot: async (rootPath) => secureRoot(rootPath),
      disposeCommandSessionsForRoot: vi.fn(async () => 0),
      evictLspServersForRoot: vi.fn(async () => undefined),
      getRootsDatabase: async () => db,
      pathExists: async () => true,
      resolveCanonicalRoot: async (rootPath) => path.normalize(rootPath),
      storage,
      ...overrides,
    });
  }

  it('fails visibly instead of treating malformed persistence as zero roots', async () => {
    storage = createStorage({ rootsList: '{broken' });
    const registry = createRegistry();

    await expect(registry.restoreRoots()).rejects.toThrow(
      'persisted workspace root registry is not valid JSON'
    );
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('keeps a transiently unmountable root persisted and returns it as unavailable', async () => {
    const entry = { addedAt: 1, path: '/workspace', rootId: 'root-a' };
    storage = createStorage({ rootsList: JSON.stringify([entry]) });
    const registry = createRegistry({
      createSecureRoot: async () => {
        throw new Error('native addon temporarily unavailable');
      },
    });

    await expect(registry.restoreRoots()).resolves.toEqual([
      expect.objectContaining({ permissionState: 'unknown', rootId: 'root-a' }),
    ]);
    expect(storage.setItem).not.toHaveBeenCalledWith('rootsList', expect.any(String));
    expect(await storage.getItem('rootsList')).toBe(JSON.stringify([entry]));
  });

  it('deduplicates aliases by canonical identity and reuses the durable root id', async () => {
    const existing = { addedAt: 1, path: '/alias/workspace', rootId: 'root-a' };
    storage = createStorage({ rootsList: JSON.stringify([existing]) });
    const canonicalByPath = new Map([
      ['/alias/workspace', '/canonical/workspace'],
      ['/another-alias/workspace', '/canonical/workspace'],
    ]);
    const registry = createRegistry({
      // Mount-then-ask: the probe's own canonicalPath is the identity
      // authority for the path being added; resolveCanonicalRoot is only
      // consulted for already-stored, unmounted entries during dedup.
      createSecureRoot: async (rootPath) =>
        secureRoot(canonicalByPath.get(rootPath) ?? path.normalize(rootPath)),
      resolveCanonicalRoot: async (rootPath) =>
        canonicalByPath.get(rootPath) ?? path.normalize(rootPath),
    });

    const descriptor = await registry.addRoot(rootHandle('/another-alias/workspace'));

    expect(descriptor).toMatchObject({
      handle: { path: '/alias/workspace', rootId: 'root-a' },
      persisted: true,
      rootId: 'root-a',
    });
    const stored = JSON.parse((await storage.getItem('rootsList')) ?? '[]') as unknown[];
    expect(stored).toHaveLength(1);
  });

  it('rolls persistence back and keeps the capability mounted when DB disconnect fails', async () => {
    const entry = { addedAt: 1, path: '/workspace', rootId: 'root-a' };
    storage = createStorage({ rootsList: JSON.stringify([entry]) });
    const mounted = secureRoot('/workspace');
    const registry = createRegistry({
      createSecureRoot: async () => mounted,
    });
    await registry.restoreRoots();
    dbQuery.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(registry.removeRoot('root-a')).rejects.toThrow('db unavailable');
    expect(await storage.getItem('rootsList')).toBe(JSON.stringify([entry]));
    expect(mounted.close).not.toHaveBeenCalled();
  });

  it('does not roll back a completed disconnect for last-folder cleanup failure', async () => {
    const entry = { addedAt: 1, path: '/workspace', rootId: 'root-a' };
    storage = createStorage({ rootsList: JSON.stringify([entry]) });
    const mounted = secureRoot('/workspace');
    const registry = createRegistry({ createSecureRoot: async () => mounted });
    await registry.restoreRoots();
    let rootRegistryRead = false;
    vi.mocked(storage.getItem).mockImplementation(async (key) => {
      if (key === 'lastFolderPath') {
        throw new Error('preference store unavailable');
      }
      if (key === 'rootsList' && !rootRegistryRead) {
        rootRegistryRead = true;
        return JSON.stringify([entry]);
      }
      return key === 'rootsList' ? '[]' : null;
    });

    await expect(registry.removeRoot('root-a')).resolves.toBeUndefined();
    expect(mounted.close).toHaveBeenCalledOnce();
  });

  it('serializes add and restore mutations behind one registry queue', async () => {
    let releaseProbe!: () => void;
    const probeBlocked = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const order: string[] = [];
    const registry = createRegistry({
      // Mount-then-ask: addRoot's first (and only, with no stored entries)
      // async dependency is the createSecureRoot probe, not
      // resolveCanonicalRoot — that is what the queue serializes behind.
      createSecureRoot: async (rootPath) => {
        order.push(`probe:${rootPath}`);
        if (rootPath === '/first') {
          await probeBlocked;
        }
        return secureRoot(rootPath);
      },
    });

    const first = registry.addRoot(rootHandle('/first'));
    const restore = registry.restoreRoots().then(() => {
      order.push('restore-complete');
    });
    await Promise.resolve();
    expect(order).toEqual(['probe:/first']);
    releaseProbe();
    await Promise.all([first, restore]);
    expect(order.at(-1)).toBe('restore-complete');
  });

  it('re-adding a folder whose persist failed reuses the session capability', async () => {
    const closes: number[] = [];
    let minted = 0;
    let failPersist = true;
    const backing = new Map<string, string>();
    storage = {
      clear: vi.fn(async () => backing.clear()),
      getAllKeys: vi.fn(async () => [...backing.keys()]),
      getItem: vi.fn(async (key: string) => backing.get(key) ?? null),
      removeItem: vi.fn(async (key: string) => {
        backing.delete(key);
      }),
      setItem: vi.fn(async (key: string, value: string) => {
        if (key === 'rootsList' && failPersist) {
          throw new Error('disk full');
        }
        backing.set(key, value);
      }),
    } as unknown as ElectronStorageAdapter;

    const registry = createRegistry({
      createSecureRoot: async () => {
        minted += 1;
        const id = minted;
        return {
          canonicalPath: '/canon/project',
          close: vi.fn(() => {
            closes.push(id);
          }),
          listDir: vi.fn(async () => ({ entries: [], inspected: 0, truncated: false })),
          readFile: vi.fn(async () => ({ status: 'unreadable' as const })),
        };
      },
    });
    const handle = rootHandle('/canon/project');

    const first = await registry.addRoot(handle);
    expect(first.persisted).toBe(false);

    failPersist = false;
    const second = await registry.addRoot(handle);
    expect(second.persisted).toBe(true);
    // Same canonical path ⇒ same durable root, not a second capability:
    expect(second.rootId).toBe(first.rootId);
    // Exactly one live mount; every superseded/probe capability was closed.
    expect(minted - closes.length).toBe(1);
  });

  it('restoreRoots adopts a persisted entry over a session mount of the same path', async () => {
    // Arrange: session root mounted (persist failed), then rootsList written
    // out-of-band with an entry whose path canonicalizes to the same root.
    const closes: number[] = [];
    let minted = 0;
    const backing = new Map<string, string>();
    storage = {
      clear: vi.fn(async () => backing.clear()),
      getAllKeys: vi.fn(async () => [...backing.keys()]),
      getItem: vi.fn(async (key: string) => backing.get(key) ?? null),
      removeItem: vi.fn(async (key: string) => {
        backing.delete(key);
      }),
      setItem: vi.fn(() => {
        throw new Error('disk full');
      }),
    } as unknown as ElectronStorageAdapter;

    const registry = createRegistry({
      createSecureRoot: async () => {
        minted += 1;
        const id = minted;
        return {
          canonicalPath: '/canon/project',
          close: vi.fn(() => {
            closes.push(id);
          }),
          listDir: vi.fn(async () => ({ entries: [], inspected: 0, truncated: false })),
          readFile: vi.fn(async () => ({ status: 'unreadable' as const })),
        };
      },
    });

    const sessionResult = await registry.addRoot(rootHandle('/canon/project'));
    expect(sessionResult.persisted).toBe(false);

    backing.set(
      'rootsList',
      JSON.stringify([{ addedAt: 1, path: '/canon/project', rootId: 'persisted-id' }])
    );

    // Assert: after restoreRoots() there is one mount, owned by the persisted
    // rootId, and the session capability was closed.
    const descriptors = await registry.restoreRoots();
    expect(descriptors.map((descriptor) => descriptor.rootId)).toEqual(['persisted-id']);
    expect(minted - closes.length).toBe(1);
  });
});
