import path from 'node:path';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRootRegistry } from '../../ipc-domains/workspace-root-registry';
import {
  createRegistry,
  createRegistryCatalogRequest,
  createStorage,
  rootHandle,
  secureRoot,
} from './workspace-root-registry-test-helpers';

/** Whether `rootId` holds a mount: only a mounted root lends a source borrow. */
async function isMounted(registry: WorkspaceRootRegistry, rootId: string): Promise<boolean> {
  try {
    const lease = await registry.borrowSourceRoot(rootId, async () => ({
      close: async () => undefined,
    }));
    await lease.retire();
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === 'Canonical source rootId is not mounted.') {
      return false;
    }
    throw error;
  }
}

describe('WorkspaceRootRegistry', () => {
  let catalogRequest: ReturnType<typeof createRegistryCatalogRequest>;
  let storage: ElectronStorageAdapter;

  beforeEach(() => {
    catalogRequest = createRegistryCatalogRequest();
    storage = createStorage();
  });

  function createTestRegistry(
    overrides: Partial<ConstructorParameters<typeof WorkspaceRootRegistry>[0]> = {}
  ): WorkspaceRootRegistry {
    return createRegistry(overrides, catalogRequest);
  }

  it('fails visibly instead of treating malformed persistence as zero roots', async () => {
    storage = createStorage({ rootsList: '{broken' });
    const registry = createTestRegistry({ storage });

    await expect(registry.restoreRoots()).rejects.toThrow(
      'persisted workspace root registry is not valid JSON'
    );
    expect(catalogRequest).not.toHaveBeenCalled();
  });

  it('addRoot quarantines a corrupt rootsList and proceeds with a fresh list', async () => {
    storage = createStorage({ rootsList: '{not json' });
    const registry = createTestRegistry({ storage });

    const descriptor = await registry.addRoot(rootHandle('/workspace'));

    expect(descriptor.persisted).toBe(true);
    expect(await storage.getItem('rootsList.corrupt')).toBe('{not json');
    const list = JSON.parse((await storage.getItem('rootsList')) ?? '[]') as unknown[];
    expect(list).toHaveLength(1);
  });

  it('notifies onRootGranted for a plain picker addRoot mount (BST-1393 review finding — fs:addRoot / fs:requestDirectoryAccess path)', async () => {
    const onRootGranted = vi.fn();
    const registry = createTestRegistry({ onRootGranted, storage });

    await registry.addRoot(rootHandle(path.resolve('/workspace')));

    expect(onRootGranted).toHaveBeenCalledExactlyOnceWith(path.resolve('/workspace'));
  });

  it('removeRoot quarantines a corrupt rootsList without half-deleting state', async () => {
    storage = createStorage({ rootsList: '{not json' });
    const registry = createTestRegistry({ storage });

    await expect(registry.removeRoot('root-a')).resolves.toBe(false);
    expect(await storage.getItem('rootsList.corrupt')).toBe('{not json');
    expect(await storage.getItem('rootsList')).toBeNull();
  });

  it('removeRoot retires an already-mounted persisted root when the store is corrupt', async () => {
    const entry = { addedAt: 1, path: '/workspace', rootId: 'root-a' };
    storage = createStorage({ rootsList: JSON.stringify([entry]) });
    const registry = createTestRegistry({
      createSecureRoot: async () => secureRoot('/workspace'),
      storage,
    });
    await registry.restoreRoots();

    // Corrupt the persisted list out-of-band while the root stays mounted —
    // the not-found branch below must not be gated on sessionRootIds, since
    // a persisted (non-session) root was never added to that set.
    await storage.setItem('rootsList', '{not json');
    catalogRequest.mockClear();

    await expect(registry.removeRoot('root-a')).resolves.toBe(true);
    await expect(isMounted(registry, 'root-a')).resolves.toBe(false);
    // The not-found branch must also converge the DB (demote the
    // now-unmounted path and run DB-id-keyed cleanup) — not just retire the
    // in-memory mount — otherwise the roots row stays live and server-side
    // consumers keep serving the folder until next boot.
    expect(catalogRequest).toHaveBeenCalledWith({
      mountedPaths: [],
      operation: 'disconnect-except',
    });
  });

  it('propagates a quarantine I/O failure instead of swallowing it', async () => {
    storage = createStorage({ rootsList: '{not json' });
    vi.mocked(storage.removeItem).mockRejectedValueOnce(new Error('disk full'));
    const registry = createTestRegistry({ storage });

    await expect(registry.addRoot(rootHandle('/workspace'))).rejects.toThrow('disk full');
  });

  it('does not quarantine a valid rootsList on a transient storage I/O failure', async () => {
    const entry = { addedAt: 1, path: '/workspace', rootId: 'root-a' };
    storage = createStorage({ rootsList: JSON.stringify([entry]) });
    vi.mocked(storage.getItem).mockRejectedValueOnce(new Error('disk read error'));
    const registry = createTestRegistry({ storage });

    await expect(registry.addRoot(rootHandle('/other'))).rejects.toThrow('disk read error');
    expect(storage.setItem).not.toHaveBeenCalledWith('rootsList.corrupt', expect.any(String));
    expect(await storage.getItem('rootsList')).toBe(JSON.stringify([entry]));
  });

  it('keeps a transiently unmountable root persisted and returns it as unavailable', async () => {
    const entry = { addedAt: 1, path: '/workspace', rootId: 'root-a' };
    storage = createStorage({ rootsList: JSON.stringify([entry]) });
    const registry = createTestRegistry({
      createSecureRoot: async () => {
        throw new Error('native addon temporarily unavailable');
      },
      storage,
    });

    await expect(registry.restoreRoots()).resolves.toEqual([
      expect.objectContaining({ permissionState: 'unknown', rootId: 'root-a' }),
    ]);
    expect(storage.setItem).not.toHaveBeenCalledWith('rootsList', expect.any(String));
    expect(await storage.getItem('rootsList')).toBe(JSON.stringify([entry]));
  });

  it('deduplicates aliases by canonical identity and reuses the durable root id', async () => {
    const alias = path.resolve('/alias/workspace');
    const anotherAlias = path.resolve('/another-alias/workspace');
    const canonical = path.resolve('/canonical/workspace');
    const existing = { addedAt: 1, path: alias, rootId: 'root-a' };
    storage = createStorage({ rootsList: JSON.stringify([existing]) });
    const canonicalByPath = new Map([
      [alias, canonical],
      [anotherAlias, canonical],
    ]);
    const registry = createTestRegistry({
      // Mount-then-ask: the probe's own canonicalPath is the identity
      // authority for the path being added; resolveCanonicalRoot is only
      // consulted for already-stored, unmounted entries during dedup.
      createSecureRoot: async (rootPath) =>
        secureRoot(canonicalByPath.get(rootPath) ?? path.normalize(rootPath)),
      resolveCanonicalRoot: async (rootPath) =>
        canonicalByPath.get(rootPath) ?? path.normalize(rootPath),
      storage,
    });

    const descriptor = await registry.addRoot(rootHandle(anotherAlias));

    expect(descriptor).toMatchObject({
      handle: { path: alias, rootId: 'root-a' },
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
    const registry = createTestRegistry({
      createSecureRoot: async () => mounted,
      storage,
    });
    await registry.restoreRoots();
    catalogRequest.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(registry.removeRoot('root-a')).rejects.toThrow('db unavailable');
    expect(await storage.getItem('rootsList')).toBe(JSON.stringify([entry]));
    expect(mounted.close).not.toHaveBeenCalled();
  });

  it('does not roll back a completed disconnect for last-folder cleanup failure', async () => {
    const entry = { addedAt: 1, path: '/workspace', rootId: 'root-a' };
    storage = createStorage({ rootsList: JSON.stringify([entry]) });
    const mounted = secureRoot('/workspace');
    const registry = createTestRegistry({
      createSecureRoot: async () => mounted,
      storage,
    });
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

    await expect(registry.removeRoot('root-a')).resolves.toBe(true);
    expect(mounted.close).toHaveBeenCalledOnce();
  });

  it('serializes add and restore mutations behind one registry queue', async () => {
    const { promise: probeBlocked, resolve: releaseProbe } = Promise.withResolvers<void>();
    const order: string[] = [];
    // Seed one stored root so restoreRoots emits its own `probe:` marker —
    // that marker must appear only after the blocked `probe:/first`,
    // making the shared-queue ordering observable end-to-end rather than
    // just at one microtask snapshot. Persistence is made to fail so
    // addRoot('/first') never merges into this same list (which would
    // otherwise make restoreRoots remount '/first' too and muddy the
    // asserted order with an incidental, still-correct second probe).
    const [firstPath, secondPath] = [path.resolve('/first'), path.resolve('/second')];
    const backing = new Map(
      Object.entries({
        rootsList: JSON.stringify([{ addedAt: 1, path: secondPath, rootId: 'root-second' }]),
      })
    );
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
    const registry = createTestRegistry({
      // Mount-then-ask: addRoot's first async dependency (once
      // readStoredRoots resolves) is the createSecureRoot probe, not
      // resolveCanonicalRoot — that is what the queue serializes behind.
      createSecureRoot: async (rootPath) => {
        order.push(`probe:${rootPath}`);
        if (rootPath === firstPath) {
          await probeBlocked;
        }
        return secureRoot(rootPath);
      },
      storage,
    });

    const first = registry.addRoot(rootHandle(firstPath));
    const restore = registry.restoreRoots().then(() => {
      order.push('restore-complete');
    });
    // Flush a macrotask boundary (not a single microtask) so every pending
    // microtask — including the sequential readStoredRoots()-then-probe
    // chain inside addRoot — has run. restoreRoots is still queued behind
    // addRoot's still-blocked probe, so its own probe cannot have fired yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([`probe:${firstPath}`]);
    releaseProbe();
    await Promise.all([first, restore]);
    expect(order).toEqual([`probe:${firstPath}`, `probe:${secondPath}`, 'restore-complete']);
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

    const registry = createTestRegistry({
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
      storage,
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

    const registry = createTestRegistry({
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
      // Bypass real filesystem validation so a read-routing assertion below
      // can exercise a fake, non-existent path.
      resolveReadPath: async (requestedPath) => path.normalize(requestedPath),
      storage,
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

    // Ownership, asserted for real: the stale session rootId's OWN mount
    // entry is gone (its capability was retired) — proven with a RELATIVE
    // path, which has no path-anchored fallback (that fallback is
    // absolute-path-only; see the "stale rootId falls back" tests below), so
    // this can only succeed by resolving `sessionResult.rootId` directly.
    // The persisted rootId now answers reads for the same canonical path.
    await expect(isMounted(registry, sessionResult.rootId)).resolves.toBe(false);
    await expect(isMounted(registry, 'persisted-id')).resolves.toBe(true);
  });

  it('reinstalling the same capability object for a rootId neither closes it nor unmounts it', async () => {
    // A caller (test seams already do this) can hand installMount the exact
    // same capability object as the incumbent for an identity-equal mount.
    // That must not be treated as "redundant, close it" — the object IS the
    // live mount, so closing it would sever the very capability being kept.
    const capability = secureRoot('/canon/project');
    const registry = createTestRegistry({
      createSecureRoot: async () => capability,
      resolveReadPath: async (requestedPath) => path.normalize(requestedPath),
      storage,
    });
    const handle = rootHandle('/canon/project');

    const first = await registry.addRoot(handle);
    const second = await registry.addRoot(handle);

    expect(second.rootId).toBe(first.rootId);
    expect(capability.close).not.toHaveBeenCalled();
    // Still mounted and serving reads, not torn down as a side effect.
    await expect(isMounted(registry, second.rootId)).resolves.toBe(true);
  });
});
