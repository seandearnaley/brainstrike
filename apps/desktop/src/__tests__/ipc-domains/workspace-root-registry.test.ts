import path from 'node:path';
import { getFileSizeConfig, setFileSizeConfig } from '@brainstrike/file-system';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/logging';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SecureWorkspaceRoot,
  WorkspaceRootRegistry,
} from '../../ipc-domains/workspace-root-registry';
import {
  createRegistry,
  createRegistryDatabaseQuery,
  createStorage,
  rootHandle,
  secureRoot,
} from './workspace-root-registry-test-helpers';

describe('WorkspaceRootRegistry', () => {
  let dbQuery: ReturnType<typeof createRegistryDatabaseQuery>;
  let storage: ElectronStorageAdapter;

  beforeEach(() => {
    dbQuery = createRegistryDatabaseQuery();
    storage = createStorage();
  });

  function createTestRegistry(
    overrides: Partial<ConstructorParameters<typeof WorkspaceRootRegistry>[0]> = {}
  ): WorkspaceRootRegistry {
    return createRegistry(overrides, dbQuery);
  }

  it('durably logs a read denial before rethrowing (BST-1257)', async () => {
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (record.scope === 'WorkspaceRootRegistry' && record.level === LogLevel.WARN) {
        captured.push(record);
      }
    });
    try {
      const registry = createTestRegistry({ storage });
      await registry.addRoot(rootHandle('/workspace'));

      // Lexically inside the mounted root, but the raw path carries a real
      // `..` segment — resolveReadPath rejects it as traversal.
      await expect(
        registry.readDirectory({
          kind: 'directory',
          name: 'etc',
          path: '/workspace/sub/../etc',
          platform: 'electron',
        })
      ).rejects.toThrow('Path validation failed');

      expect(captured).toHaveLength(1);
      expect(captured[0]?.args[1]).toMatchObject({
        operation: 'readDirectory',
        requestedPath: '/workspace/sub/../etc',
      });
    } finally {
      removeListener();
    }
  });

  it('durably logs post-resolution denials such as an inaccessible directory', async () => {
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (record.scope === 'WorkspaceRootRegistry' && record.level === LogLevel.WARN) {
        captured.push(record);
      }
    });
    try {
      const inaccessible: SecureWorkspaceRoot = {
        ...secureRoot('/workspace'),
        listDir: vi.fn(async () => null),
      };
      const registry = createTestRegistry({
        createSecureRoot: async () => inaccessible,
        resolveReadPath: async (requestedPath) => path.normalize(requestedPath),
        storage,
      });
      await registry.addRoot(rootHandle('/workspace'));

      await expect(
        registry.readDirectory({
          kind: 'directory',
          name: 'workspace',
          path: '/workspace',
          platform: 'electron',
        })
      ).rejects.toThrow('Directory is not accessible.');

      expect(captured).toHaveLength(1);
      expect(captured[0]?.args[1]).toMatchObject({ operation: 'readDirectory' });
    } finally {
      removeListener();
    }
  });

  it('does not warn-log routine not-found file reads', async () => {
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (record.scope === 'WorkspaceRootRegistry' && record.level === LogLevel.WARN) {
        captured.push(record);
      }
    });
    try {
      const missing: SecureWorkspaceRoot = {
        ...secureRoot('/workspace'),
        readFile: vi.fn(async () => ({ status: 'not-found' as const })),
      };
      const registry = createTestRegistry({
        createSecureRoot: async () => missing,
        resolveReadPath: async (requestedPath) => path.normalize(requestedPath),
        storage,
      });
      await registry.addRoot(rootHandle('/workspace'));

      await expect(registry.readFile('/workspace/missing.txt')).rejects.toThrow('ENOENT');

      expect(captured).toHaveLength(0);
    } finally {
      removeListener();
    }
  });

  it('binds a scoped absolute read to rootId when duplicate presentation paths retarget', async () => {
    const sharedPresentationPath = '/workspace-link';
    const rootA = secureRoot('/canonical/target-a');
    const rootB = secureRoot('/canonical/target-b');
    vi.mocked(rootA.readFile).mockResolvedValue({
      content: Buffer.from('target-a'),
      status: 'ok',
    });
    vi.mocked(rootB.readFile).mockResolvedValue({
      content: Buffer.from('target-b'),
      status: 'ok',
    });
    storage = createStorage({
      rootsList: JSON.stringify([
        { addedAt: 1, path: sharedPresentationPath, rootId: 'root-a' },
        { addedAt: 2, path: sharedPresentationPath, rootId: 'root-b' },
      ]),
    });
    let mountCount = 0;
    const registry = createTestRegistry({
      createSecureRoot: async () => {
        mountCount += 1;
        return mountCount === 1 ? rootA : rootB;
      },
      resolveReadPath: async (requestedPath, canonicalRoot) =>
        path.join(canonicalRoot, path.basename(requestedPath)),
      storage,
    });
    await registry.restoreRoots();
    const readScoped = registry.readFileByAbsolutePath.bind(registry) as unknown as (
      requestedPath: unknown,
      claimedRootPath: unknown,
      claimedRootId: unknown
    ) => Promise<string>;

    await expect(
      readScoped(`${sharedPresentationPath}/file.txt`, sharedPresentationPath, 'root-b')
    ).resolves.toBe('target-b');
    expect(rootA.readFile).not.toHaveBeenCalled();
    expect(rootB.readFile).toHaveBeenCalledWith('file.txt', expect.any(Number));
    await expect(
      readScoped(`${sharedPresentationPath}/file.txt`, '/canonical/target-a', 'root-b')
    ).rejects.toThrow('does not match the mounted workspace root');
    await expect(
      readScoped(`${sharedPresentationPath}/file.txt`, sharedPresentationPath, undefined)
    ).rejects.toThrow('durable rootId');
  });

  it('logs malformed scoped authority exactly once without expanding non-string diagnostics', async () => {
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (
        record.scope === 'WorkspaceRootRegistry' &&
        record.level === LogLevel.WARN &&
        record.message === 'Workspace read denied'
      ) {
        captured.push(record);
      }
    });
    try {
      const registry = createTestRegistry({ storage });
      const readScoped = registry.readFileByAbsolutePath.bind(registry) as unknown as (
        requestedPath: unknown,
        claimedRootPath: unknown,
        claimedRootId: unknown
      ) => Promise<string>;

      await expect(
        readScoped({ secret: 'must-not-be-logged' }, '/workspace', 'root-a')
      ).rejects.toThrow('Requested file path must be a non-empty native absolute path.');

      expect(captured).toHaveLength(1);
      expect(captured[0]?.args[1]).toMatchObject({
        operation: 'readFileByAbsolutePath',
        requestedPath: '',
      });
      expect(JSON.stringify(captured)).not.toContain('must-not-be-logged');
    } finally {
      removeListener();
    }
  });

  it.each([
    {
      name: 'a multi-megabyte absolute path',
      requestedPath: `/${'a'.repeat(2_000_000)}RAW_DIAGNOSTIC_TAIL_MUST_NOT_APPEAR`,
      verify: (diagnosticPath: string) => {
        expect(diagnosticPath).toContain('[truncated]');
        expect(diagnosticPath).not.toContain('RAW_DIAGNOSTIC_TAIL_MUST_NOT_APPEAR');
      },
    },
    {
      name: 'a path containing renderer-controlled line breaks and controls',
      requestedPath: '/workspace/line-one\nline-two\tcontrol',
      verify: (diagnosticPath: string) => {
        expect(diagnosticPath).toContain('\\u000a');
        expect(diagnosticPath).toContain('\\u0009');
        expect(diagnosticPath).not.toMatch(/[\n\r\t]/u);
      },
    },
  ])('bounds the denial diagnostic for $name', async ({ requestedPath, verify }) => {
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (
        record.scope === 'WorkspaceRootRegistry' &&
        record.level === LogLevel.WARN &&
        record.message === 'Workspace read denied'
      ) {
        captured.push(record);
      }
    });
    try {
      const registry = createTestRegistry({ storage });
      const readScoped = registry.readFileByAbsolutePath.bind(registry) as unknown as (
        requestedPath: unknown,
        claimedRootPath: unknown,
        claimedRootId: unknown
      ) => Promise<string>;

      await expect(readScoped(requestedPath, '/workspace', 'root-a')).rejects.toThrow();

      expect(captured).toHaveLength(1);
      const diagnosticFields = captured[0]?.args[1];
      if (!(diagnosticFields && typeof diagnosticFields === 'object')) {
        throw new Error('Missing denial diagnostic fields');
      }
      const diagnosticPath = (diagnosticFields as { requestedPath?: unknown }).requestedPath;
      if (typeof diagnosticPath !== 'string') {
        throw new Error('Missing denial diagnostic path');
      }
      expect(diagnosticPath.length).toBeLessThanOrEqual(256);
      verify(diagnosticPath);
    } finally {
      removeListener();
    }
  });

  it.each([
    {
      name: 'directory',
      read: (registry: WorkspaceRootRegistry, rootId: string) =>
        registry.readDirectory({
          kind: 'directory',
          name: 'workspace',
          path: '/workspace',
          platform: 'electron',
          rootId,
        }),
    },
    {
      name: 'file',
      read: (registry: WorkspaceRootRegistry, rootId: string) =>
        registry.readFile({
          kind: 'file',
          name: 'file.txt',
          path: '/workspace/file.txt',
          platform: 'electron',
          rootId,
        }),
    },
  ])('bounds renderer-controlled rootId on denied $name reads', async ({ read }) => {
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (
        record.scope === 'WorkspaceRootRegistry' &&
        record.level === LogLevel.WARN &&
        record.message === 'Workspace read denied'
      ) {
        captured.push(record);
      }
    });
    const rawTail = 'RAW_ROOT_ID_TAIL_MUST_NOT_APPEAR';
    const rootId = `renderer\nroot-${'r'.repeat(2_000_000)}${rawTail}`;
    try {
      await expect(read(createTestRegistry({ storage }), rootId)).rejects.toThrow();

      expect(captured).toHaveLength(1);
      const diagnosticFields = captured[0]?.args[1];
      if (!(diagnosticFields && typeof diagnosticFields === 'object')) {
        throw new Error('Missing denial diagnostic fields');
      }
      const diagnosticRootId = (diagnosticFields as { rootId?: unknown }).rootId;
      if (typeof diagnosticRootId !== 'string') {
        throw new Error('Missing denial diagnostic rootId');
      }
      expect(diagnosticRootId.length).toBeLessThanOrEqual(256);
      expect(diagnosticRootId).toContain('\\u000a');
      expect(diagnosticRootId).toContain('[truncated]');
      expect(diagnosticRootId).not.toContain(rawTail);
      expect(diagnosticRootId).not.toMatch(/[\n\r\t]/u);
    } finally {
      removeListener();
    }
  });

  it('fails visibly instead of treating malformed persistence as zero roots', async () => {
    storage = createStorage({ rootsList: '{broken' });
    const registry = createTestRegistry({ storage });

    await expect(registry.restoreRoots()).rejects.toThrow(
      'persisted workspace root registry is not valid JSON'
    );
    expect(dbQuery).not.toHaveBeenCalled();
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

    await registry.addRoot(rootHandle('/workspace'));

    expect(onRootGranted).toHaveBeenCalledExactlyOnceWith('/workspace');
  });

  it('removeRoot quarantines a corrupt rootsList without half-deleting state', async () => {
    storage = createStorage({ rootsList: '{not json' });
    const registry = createTestRegistry({ storage });

    await expect(registry.removeRoot('root-a')).resolves.toBeUndefined();
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
    dbQuery.mockClear();

    await expect(registry.removeRoot('root-a')).resolves.toBeUndefined();
    await expect(
      registry.readDirectory({
        kind: 'directory',
        name: 'workspace',
        path: '/workspace',
        platform: 'electron',
        rootId: 'root-a',
      })
    ).rejects.toThrow('Workspace root is not mounted.');
    // The not-found branch must also converge the DB (demote the
    // now-unmounted path and run DB-id-keyed cleanup) — not just retire the
    // in-memory mount — otherwise the roots row stays live and server-side
    // consumers keep serving the folder until next boot.
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE roots'),
      expect.anything()
    );
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
    const existing = { addedAt: 1, path: '/alias/workspace', rootId: 'root-a' };
    storage = createStorage({ rootsList: JSON.stringify([existing]) });
    const canonicalByPath = new Map([
      ['/alias/workspace', '/canonical/workspace'],
      ['/another-alias/workspace', '/canonical/workspace'],
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
    const registry = createTestRegistry({
      createSecureRoot: async () => mounted,
      storage,
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

    await expect(registry.removeRoot('root-a')).resolves.toBeUndefined();
    expect(mounted.close).toHaveBeenCalledOnce();
  });

  it('serializes add and restore mutations behind one registry queue', async () => {
    let releaseProbe!: () => void;
    const probeBlocked = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const order: string[] = [];
    // Seed one stored root so restoreRoots emits its own `probe:` marker —
    // that marker must appear only after the blocked `probe:/first`,
    // making the shared-queue ordering observable end-to-end rather than
    // just at one microtask snapshot. Persistence is made to fail so
    // addRoot('/first') never merges into this same list (which would
    // otherwise make restoreRoots remount '/first' too and muddy the
    // asserted order with an incidental, still-correct second probe).
    const backing = new Map(
      Object.entries({
        rootsList: JSON.stringify([{ addedAt: 1, path: '/second', rootId: 'root-second' }]),
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
        if (rootPath === '/first') {
          await probeBlocked;
        }
        return secureRoot(rootPath);
      },
      storage,
    });

    const first = registry.addRoot(rootHandle('/first'));
    const restore = registry.restoreRoots().then(() => {
      order.push('restore-complete');
    });
    // Flush a macrotask boundary (not a single microtask) so every pending
    // microtask — including the sequential readStoredRoots()-then-probe
    // chain inside addRoot — has run. restoreRoots is still queued behind
    // addRoot's still-blocked probe, so its own probe cannot have fired yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['probe:/first']);
    releaseProbe();
    await Promise.all([first, restore]);
    expect(order).toEqual(['probe:/first', 'probe:/second', 'restore-complete']);
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
    await expect(
      registry.readFile({
        kind: 'file',
        name: 'a.md',
        path: 'a.md',
        platform: 'electron',
        rootId: sessionResult.rootId,
      })
    ).rejects.toThrow('Workspace root is not mounted.');
    await expect(
      registry.readDirectory({
        kind: 'directory',
        name: 'project',
        path: '/canon/project',
        platform: 'electron',
        rootId: 'persisted-id',
      })
    ).resolves.toEqual([]);
  });

  it('a truncated listing returns the partial entries plus a visible marker node', async () => {
    const registry = createTestRegistry({
      createSecureRoot: async () => ({
        canonicalPath: '/canon/project',
        close: vi.fn(),
        listDir: vi.fn(async () => ({
          entries: [
            { isDirectory: false, isFile: true, isSymbolicLink: false, name: 'a.md', size: 1 },
            { isDirectory: true, isFile: false, isSymbolicLink: false, name: 'sub' },
          ],
          inspected: 10_000,
          truncated: true,
        })),
        readFile: vi.fn(async () => ({ status: 'unreadable' as const })),
      }),
      // Bypass real filesystem validation for the fake canonical path.
      resolveReadPath: async (requestedPath) => path.normalize(requestedPath),
      storage,
    });
    const descriptor = await registry.addRoot(rootHandle('/canon/project'));

    const nodes = await registry.readDirectory({
      kind: 'directory',
      name: 'project',
      path: descriptor.handle.path,
      platform: 'electron',
      rootId: descriptor.rootId,
    });

    expect(nodes).toHaveLength(3);
    const markers = nodes.filter((node) => node.type === 'truncated');
    expect(markers).toHaveLength(1);
    const marker = nodes.at(-1);
    expect(marker?.type).toBe('truncated');
    expect(marker?.name).toBe('Showing first 10,000 entries');
    expect(marker?.selectionState).toBe('unchecked');
    expect(marker?.path).toBe(path.join(descriptor.handle.path, '…truncated…'));
  });

  it('mounts a new root under its presentation path while canonical-path reads route to it', async () => {
    const registry = createTestRegistry({
      createSecureRoot: async () => secureRoot('/real/workspace'),
      // Bypass real filesystem validation for the fake canonical path.
      resolveReadPath: async (requestedPath) => path.normalize(requestedPath),
      storage,
    });

    const descriptor = await registry.addRoot(rootHandle('/alias/workspace'));
    // The stored/returned identity is the presentation path the caller used...
    expect(descriptor.handle.path).toBe('/alias/workspace');
    expect(descriptor.persisted).toBe(true);

    // ...but the mounted record also carries the capability's own canonical
    // path: an absolute-path read with no rootId is resolved purely via
    // WorkspaceRootMountTable's findForAbsolutePath, which only succeeds here if the
    // mount's canonicalPath (not just its presentationPath) is on file.
    await expect(
      registry.readDirectory({
        kind: 'directory',
        name: 'workspace',
        path: '/real/workspace',
        platform: 'electron',
      })
    ).resolves.toEqual([]);
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
    await expect(
      registry.readDirectory({
        kind: 'directory',
        name: 'project',
        path: '/canon/project',
        platform: 'electron',
        rootId: second.rootId,
      })
    ).resolves.toEqual([]);
  });

  it('a configured maxFileSize above the native cap fails loud, not unreadable', async () => {
    const registry = createTestRegistry({
      resolveReadPath: async (requestedPath) => path.normalize(requestedPath),
      storage,
    });
    const descriptor = await registry.addRoot(rootHandle('/canon/project'));
    const defaultFileSizeConfig = getFileSizeConfig();
    setFileSizeConfig({ maxFileSize: 17 * 1024 * 1024 });
    try {
      await expect(
        registry.readFile({
          kind: 'file',
          name: 'a.md',
          path: '/canon/project/a.md',
          platform: 'electron',
          rootId: descriptor.rootId,
        })
      ).rejects.toThrow(/exceeds the native secure-read cap/);
    } finally {
      setFileSizeConfig(defaultFileSizeConfig);
    }
  });

  it('a symlink entry propagates isSymbolicLink on the returned file/directory nodes', async () => {
    const registry = createTestRegistry({
      createSecureRoot: async () => ({
        canonicalPath: '/canon/project',
        close: vi.fn(),
        listDir: vi.fn(async () => ({
          entries: [
            { isDirectory: false, isFile: true, isSymbolicLink: true, name: 'link.txt' },
            { isDirectory: false, isFile: true, isSymbolicLink: false, name: 'plain.txt' },
            // A symlink to a directory is classified under the file branch
            // (buildDirectoryNode: isDirectory && !isSymbolicLink) — still
            // must carry the flag.
            { isDirectory: true, isFile: false, isSymbolicLink: true, name: 'link-dir' },
          ],
          inspected: 3,
          truncated: false,
        })),
        readFile: vi.fn(async () => ({ status: 'unreadable' as const })),
      }),
      resolveReadPath: async (requestedPath) => path.normalize(requestedPath),
      storage,
    });
    const descriptor = await registry.addRoot(rootHandle('/canon/project'));

    const nodes = await registry.readDirectory({
      kind: 'directory',
      name: 'project',
      path: descriptor.handle.path,
      platform: 'electron',
      rootId: descriptor.rootId,
    });

    expect(nodes.find((node) => node.name === 'link.txt')?.isSymbolicLink).toBe(true);
    expect(nodes.find((node) => node.name === 'link-dir')?.isSymbolicLink).toBe(true);
    expect(nodes.find((node) => node.name === 'plain.txt')?.isSymbolicLink).toBeUndefined();
  });

  it('readFile throws a precise symlink error when the realpath preflight resolves off the lexical target', async () => {
    const registry = createTestRegistry({
      createSecureRoot: async () => ({
        canonicalPath: '/canon/project',
        close: vi.fn(),
        listDir: vi.fn(async () => ({ entries: [], inspected: 0, truncated: false })),
        readFile: vi.fn(async () => ({ status: 'unreadable' as const })),
      }),
      // Simulate a symlinked leaf: the realpath preflight resolves the
      // requested path to a DIFFERENT (but still in-root) target than its
      // purely lexical join — exactly what a traversed/leaf symlink does.
      resolveReadPath: async (requestedPath) =>
        requestedPath.endsWith('link.txt')
          ? '/canon/project/real-target.txt'
          : path.normalize(requestedPath),
      storage,
    });
    const descriptor = await registry.addRoot(rootHandle('/canon/project'));

    await expect(
      registry.readFile({
        kind: 'file',
        name: 'link.txt',
        path: '/canon/project/link.txt',
        platform: 'electron',
        rootId: descriptor.rootId,
      })
    ).rejects.toThrow('File is a symbolic link. Links are not followed inside workspace roots.');
  });

  it('readFile keeps the generic error message for a genuinely unreadable non-symlink file', async () => {
    const registry = createTestRegistry({
      createSecureRoot: async () => ({
        canonicalPath: '/canon/project',
        close: vi.fn(),
        listDir: vi.fn(async () => ({ entries: [], inspected: 0, truncated: false })),
        readFile: vi.fn(async () => ({ status: 'unreadable' as const })),
      }),
      resolveReadPath: async (requestedPath) => path.normalize(requestedPath),
      storage,
    });
    const descriptor = await registry.addRoot(rootHandle('/canon/project'));

    await expect(
      registry.readFile({
        kind: 'file',
        name: 'locked.txt',
        path: '/canon/project/locked.txt',
        platform: 'electron',
        rootId: descriptor.rootId,
      })
    ).rejects.toThrow('File is not accessible.');
  });

  it('a stale rootId falls back to path resolution for an in-root absolute path', async () => {
    const registry = createTestRegistry({
      createSecureRoot: async () => secureRoot('/canon/project'),
      resolveReadPath: async (requestedPath) => path.normalize(requestedPath),
      storage,
    });
    const descriptor = await registry.addRoot(rootHandle('/canon/project'));
    expect(descriptor.rootId).not.toBe('stale-root-id');

    // Same containment + preflight as the no-rootId path — not a security
    // delta, just a second, path-anchored way to find the same mounted root.
    await expect(
      registry.readDirectory({
        kind: 'directory',
        name: 'project',
        path: descriptor.handle.path,
        platform: 'electron',
        rootId: 'stale-root-id',
      })
    ).resolves.toEqual([]);
  });

  it('a stale rootId with an out-of-root absolute path is still rejected', async () => {
    const registry = createTestRegistry({
      createSecureRoot: async () => secureRoot('/canon/project'),
      resolveReadPath: async (requestedPath) => path.normalize(requestedPath),
      storage,
    });
    await registry.addRoot(rootHandle('/canon/project'));

    await expect(
      registry.readDirectory({
        kind: 'directory',
        name: 'elsewhere',
        path: '/canon/elsewhere',
        platform: 'electron',
        rootId: 'stale-root-id',
      })
    ).rejects.toThrow('Workspace root is not mounted.');
  });

  it('a stale rootId with a relative path has no anchor and is still rejected', async () => {
    const registry = createTestRegistry({
      createSecureRoot: async () => secureRoot('/canon/project'),
      resolveReadPath: async (requestedPath) => path.normalize(requestedPath),
      storage,
    });
    await registry.addRoot(rootHandle('/canon/project'));

    await expect(
      registry.readFile({
        kind: 'file',
        name: 'a.md',
        path: 'a.md',
        platform: 'electron',
        rootId: 'stale-root-id',
      })
    ).rejects.toThrow('Workspace root is not mounted.');
  });

  it('an inherited rootId anchors a nested read to the traversal (outer) root, not the innermost path-matched mount (pinned intent)', async () => {
    const outerListDir = vi.fn(async () => ({ entries: [], inspected: 0, truncated: false }));
    const innerListDir = vi.fn(async () => ({ entries: [], inspected: 0, truncated: false }));
    const registry = createTestRegistry({
      createSecureRoot: async (rootPath) => ({
        ...secureRoot(rootPath),
        listDir: rootPath === '/canon/outer' ? outerListDir : innerListDir,
      }),
      resolveReadPath: async (requestedPath) => path.normalize(requestedPath),
      storage,
    });

    const outer = await registry.addRoot(rootHandle('/canon/outer'));
    // A second root nested inside the first: findForAbsolutePath
    // would normally pick this one for a path under it (longest containing
    // path wins), but a caller-supplied rootId short-circuits that lookup.
    await registry.addRoot(rootHandle('/canon/outer/nested'));

    // Reads made during a traversal anchored at the outer root are
    // authorized and attributed under the outer root's capability — that is
    // the intent, not a side effect: `resolveForRead` short-circuits to
    // `this.mounted.get(rootId)` before ever consulting path containment. A
    // self-identifying nested root still wins via the caller supplying its
    // OWN rootId (entryHandle?.rootId ?? parent.rootId precedence upstream);
    // this only anchors to the outer mount when the caller has none more
    // specific to offer.
    await registry.readDirectory({
      kind: 'directory',
      name: 'child',
      path: '/canon/outer/nested/child',
      platform: 'electron',
      rootId: outer.rootId,
    });

    expect(outerListDir).toHaveBeenCalled();
    expect(innerListDir).not.toHaveBeenCalled();
  });
});
