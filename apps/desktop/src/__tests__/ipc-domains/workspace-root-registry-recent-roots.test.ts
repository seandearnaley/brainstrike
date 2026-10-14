import {
  WORKSPACE_ROOT_MANAGED_BUT_UNAUTHORIZED_MESSAGE,
  WORKSPACE_ROOT_NEVER_GRANTED_MESSAGE,
} from '@brainstrike/app-shell/workspace-connect/workspace-connect-bridge';
import type { WorkspaceRootReply } from '@brainstrike/state-store';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RECENT_ROOTS_LIMIT,
  resolveGrantedRootHandle,
} from '../../ipc-domains/workspace-recent-roots';
import { loggerMock } from './workspace-root-registry-logger-test-helper';
import {
  createRegistry,
  createRegistryCatalogRequest,
  createStorage,
  registryRoot,
  rootHandle,
} from './workspace-root-registry-test-helpers';

// Quarantine and write-failure paths log deliberately. Capturing the logger
// keeps the suite's output pristine AND makes "it was reported" an assertion
// rather than something a reader has to spot in the scrollback.
vi.mock('@brainstrike/logging', async (importOriginal) => {
  const { loggerMock: sharedLoggerMock } = await import(
    './workspace-root-registry-logger-test-helper'
  );
  return {
    ...(await importOriginal<typeof import('@brainstrike/logging')>()),
    createLogger: () => sharedLoggerMock,
  };
});

const QUARANTINE_MESSAGE = 'Quarantined a corrupt recently-granted workspace folder ledger';

describe('WorkspaceRootRegistry recent-roots ledger + addRootByPath', () => {
  let storage: ElectronStorageAdapter;

  beforeEach(() => {
    storage = createStorage();
    loggerMock.error.mockClear();
    loggerMock.info.mockClear();
    loggerMock.warn.mockClear();
  });

  it('records every successful addRoot in recentRootsList, newest first, deduped', async () => {
    const registry = createRegistry({ storage });
    await registry.addRoot(rootHandle('/ws/alpha'));
    await registry.addRoot(rootHandle('/ws/beta'));
    await registry.addRoot(rootHandle('/ws/alpha'));

    const recents = await registry.listRecentRoots();
    expect(recents.map((entry) => entry.path)).toEqual(['/ws/alpha', '/ws/beta']);
    expect(recents[0]?.displayName).toBe('alpha');
    expect(JSON.parse((await storage.getItem('recentRootsList')) ?? '[]')).toHaveLength(2);
  });

  it('caps the ledger at the newest RECENT_ROOTS_LIMIT grants', async () => {
    const registry = createRegistry({ storage });
    const overflow = RECENT_ROOTS_LIMIT + 2;
    for (let index = 0; index < overflow; index += 1) {
      // eslint-disable-next-line react-doctor/async-await-in-loop -- grants must land serially: the cap under test is an ordering property of the grant sequence.
      await registry.addRoot(rootHandle(`/ws/root-${index}`));
    }

    const recents = await registry.listRecentRoots();
    expect(recents).toHaveLength(RECENT_ROOTS_LIMIT);
    expect(recents[0]?.path).toBe(`/ws/root-${overflow - 1}`);
    expect(recents.at(-1)?.path).toBe('/ws/root-2');
  });

  it('keys a trailing-separator path to the same ledger slot as the bare path', async () => {
    const registry = createRegistry({ storage });
    await registry.addRoot(rootHandle('/ws/alpha/'));

    const recents = await registry.listRecentRoots();
    expect(recents.map((entry) => entry.path)).toEqual(['/ws/alpha']);

    await registry.addRoot(rootHandle('/ws/alpha'));
    expect((await registry.listRecentRoots()).map((entry) => entry.path)).toEqual(['/ws/alpha']);

    // Lookup normalizes too: either spelling resolves the one grant.
    await expect(registry.addRootByPath('/ws/alpha/')).resolves.toMatchObject({
      permissionState: 'granted',
    });
  });

  it('keeps disconnected grants past the connected-root count within the cap', async () => {
    const registry = createRegistry({ storage });
    await registry.addRoot(rootHandle('/ws/disconnected'));
    const disconnected = await registry.listRecentRoots();
    expect(disconnected.map((entry) => entry.path)).toEqual(['/ws/disconnected']);

    // A user with many folders connected at once must not evict earlier
    // grants: the cap is storage hygiene, well above realistic mount counts.
    for (let index = 0; index < 24; index += 1) {
      // eslint-disable-next-line react-doctor/async-await-in-loop -- grants must land serially to reproduce the eviction pressure under test.
      await registry.addRoot(rootHandle(`/ws/mounted-${index}`));
    }

    const recents = await registry.listRecentRoots();
    expect(recents.map((entry) => entry.path)).toContain('/ws/disconnected');
    await expect(registry.addRootByPath('/ws/disconnected')).resolves.toMatchObject({
      permissionState: 'granted',
    });
  });

  it('addRootByPath mounts a previously granted path without a picker and rejects an unknown one', async () => {
    const registry = createRegistry({ storage });
    await registry.addRoot(rootHandle('/ws/alpha'));
    const restored = await registry.restoreRoots();
    const restoredRootId = restored[0]?.rootId;
    expect(restoredRootId).toBeDefined();
    // Disconnecting drops the root from rootsList but must NOT revoke the
    // grant — that separation is what addRootByPath relies on.
    await registry.removeRoot(restoredRootId as string);

    const descriptor = await registry.addRootByPath('/ws/alpha');
    expect(descriptor.handle.path).toBe('/ws/alpha');
    expect(descriptor.permissionState).toBe('granted');

    await expect(registry.addRootByPath('/ws/never')).rejects.toThrow(
      'Folder was never granted in this app; use Add Folder to grant it.'
    );
  });

  it('notifies onRootGranted for a recents-ledger picker-less addRootByPath mount (BST-1393 review finding)', async () => {
    const onRootGranted = vi.fn();
    const registry = createRegistry({ onRootGranted, storage });
    await registry.addRoot(rootHandle('/ws/alpha'));
    onRootGranted.mockClear(); // isolate the addRootByPath re-mount below

    const restored = await registry.restoreRoots();
    const restoredRootId = restored[0]?.rootId;
    await registry.removeRoot(restoredRootId as string);

    await registry.addRootByPath('/ws/alpha');

    expect(onRootGranted).toHaveBeenCalledExactlyOnceWith('/ws/alpha');
  });

  it('refreshes a recents-granted addRootByPath entry', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2000);
      await storage.setItem(
        'recentRootsList',
        JSON.stringify([{ lastGrantedAt: 1000, path: '/ws/alpha' }])
      );
      const registry = createRegistry({ storage });

      await registry.addRootByPath('/ws/alpha');

      await expect(registry.listRecentRoots()).resolves.toEqual([
        expect.objectContaining({ lastGrantedAt: 2000, path: '/ws/alpha' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not record an authorizer-granted managed worktree in Recents', async () => {
    const registry = createRegistry({ storage });
    registry.setManagedWorktreeAuthorizer(() => Promise.resolve('authorized'));

    await expect(registry.addRootByPath('/managed/app/bright-fox')).resolves.toMatchObject({
      permissionState: 'granted',
    });

    await expect(registry.listRecentRoots()).resolves.toEqual([]);
    expect(loggerMock.info).toHaveBeenCalledWith('Mounted managed worktree without picker', {
      path: '/managed/app/bright-fox',
      rootId: expect.any(String),
    });
  });

  it('keeps a persisted managed worktree out of Recents after relaunch restore', async () => {
    const firstRegistry = createRegistry({ storage });
    firstRegistry.setManagedWorktreeAuthorizer(() => Promise.resolve('authorized'));
    await firstRegistry.addRootByPath('/managed/app/bright-fox');
    const storedRoots = JSON.parse((await storage.getItem('rootsList')) ?? '[]') as Array<{
      rootId: string;
    }>;
    const worktreeRootId = storedRoots[0]?.rootId;
    expect(worktreeRootId).toBeDefined();
    await expect(firstRegistry.listRecentRoots()).resolves.toEqual([]);

    if (!worktreeRootId) {
      throw new Error('Missing mounted worktree ID');
    }
    const catalogRequest = createRegistryCatalogRequest([
      registryRoot(worktreeRootId, '/managed/app/bright-fox', 'worktree'),
    ]);
    const relaunchedRegistry = createRegistry({ storage }, catalogRequest);

    await relaunchedRegistry.restoreRoots();

    await expect(relaunchedRegistry.listRecentRoots()).resolves.toEqual([]);
  });

  it('still records an ordinary persisted root in Recents after relaunch restore', async () => {
    const firstRegistry = createRegistry({ storage });
    await firstRegistry.addRoot(rootHandle('/ws/ordinary'));
    const storedRoots = JSON.parse((await storage.getItem('rootsList')) ?? '[]') as Array<{
      rootId: string;
    }>;
    const ordinaryRootId = storedRoots[0]?.rootId;
    expect(ordinaryRootId).toBeDefined();
    await storage.removeItem('recentRootsList');

    if (!ordinaryRootId) {
      throw new Error('Missing mounted folder ID');
    }
    const catalogRequest = createRegistryCatalogRequest([
      registryRoot(ordinaryRootId, '/ws/ordinary'),
    ]);
    const relaunchedRegistry = createRegistry({ storage }, catalogRequest);

    await relaunchedRegistry.restoreRoots();

    await expect(relaunchedRegistry.listRecentRoots()).resolves.toEqual([
      expect.objectContaining({ path: '/ws/ordinary' }),
    ]);
  });

  it('mounts restored roots before reading persisted kinds from the database', async () => {
    await storage.setItem(
      'rootsList',
      JSON.stringify([{ addedAt: 1, path: '/ws/ordinary', rootId: 'root-ordinary' }])
    );
    const order: string[] = [];
    let resolveKindQuery!: (value: WorkspaceRootReply) => void;
    const kindQuery = new Promise<WorkspaceRootReply>((resolve) => {
      resolveKindQuery = resolve;
    });
    const catalogRequest = createRegistryCatalogRequest();
    const respond = catalogRequest.getMockImplementation()!;
    catalogRequest.mockImplementation(async (request) => {
      if (request.operation === 'list') {
        order.push('kind-query');
        return await kindQuery;
      }
      return respond(request);
    });
    const registry = createRegistry(
      {
        createSecureRoot: async (rootPath) => {
          order.push(`mount:${rootPath}`);
          return {
            canonicalPath: rootPath,
            close: vi.fn(),
            listDir: vi.fn(async () => ({ entries: [], inspected: 0, truncated: false })),
            readFile: vi.fn(async () => ({
              content: Buffer.from('inside'),
              status: 'ok' as const,
            })),
          };
        },
        storage,
      },
      catalogRequest
    );

    const restoring = registry.restoreRoots();
    await vi.waitFor(() => expect(order).toContain('kind-query'));
    expect(order).toEqual(['mount:/ws/ordinary', 'kind-query']);
    resolveKindQuery({ roots: [registryRoot('root-ordinary', '/ws/ordinary')] });
    await restoring;
  });

  it('fails open to recording Recents when the persisted-kind query throws', async () => {
    await storage.setItem(
      'rootsList',
      JSON.stringify([{ addedAt: 1, path: '/ws/ordinary', rootId: 'root-ordinary' }])
    );
    const catalogRequest = createRegistryCatalogRequest();
    const respond = catalogRequest.getMockImplementation()!;
    catalogRequest.mockImplementation(async (request) => {
      if (request.operation === 'list') {
        throw new Error('database unavailable');
      }
      return respond(request);
    });
    const registry = createRegistry({ storage }, catalogRequest);

    await registry.restoreRoots();

    await expect(registry.listRecentRoots()).resolves.toEqual([
      expect.objectContaining({ path: '/ws/ordinary' }),
    ]);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Could not read persisted workspace root kinds; restoring Recents as before',
      { error: expect.any(Error) }
    );
  });

  it('restoreRoots records an absent restored entry with its stored addedAt', async () => {
    const registry = createRegistry({ storage });
    await storage.setItem(
      'rootsList',
      JSON.stringify([{ addedAt: 1_700_000_000_000, path: '/ws/gamma', rootId: 'r-gamma' }])
    );

    await registry.restoreRoots();

    const recents = await registry.listRecentRoots();
    expect(recents.map((entry) => entry.path)).toEqual(['/ws/gamma']);
    expect(recents[0]?.lastGrantedAt).toBe(1_700_000_000_000);
  });

  it('does not churn lastGrantedAt on a second restoreRoots for an already-recorded path', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const registry = createRegistry({ storage });
      await storage.setItem(
        'rootsList',
        JSON.stringify([{ addedAt: 1, path: '/ws/gamma', rootId: 'r-gamma' }])
      );

      await registry.restoreRoots();
      const firstGrantedAt = (await registry.listRecentRoots())[0]?.lastGrantedAt;
      expect(firstGrantedAt).toBe(1);

      // Advance the clock so a churned ledger entry would visibly differ.
      vi.setSystemTime(2_000_000);
      await registry.restoreRoots();
      const secondGrantedAt = (await registry.listRecentRoots())[0]?.lastGrantedAt;

      expect(secondGrantedAt).toBe(firstGrantedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records a multi-root restore with ONE shared ledger read, in the same order per-entry recording would produce (BST-1400 item 4)', async () => {
    await storage.setItem(
      'rootsList',
      JSON.stringify([
        { addedAt: 1, path: '/ws/alpha', rootId: 'r-alpha' },
        { addedAt: 2, path: '/ws/beta', rootId: 'r-beta' },
        { addedAt: 3, path: '/ws/gamma', rootId: 'r-gamma' },
      ])
    );
    const registry = createRegistry({ storage });
    const getItemMock = vi.mocked(storage.getItem);
    const setItemMock = vi.mocked(storage.setItem);
    getItemMock.mockClear();
    setItemMock.mockClear();

    await registry.restoreRoots();

    const recentRootsReads = getItemMock.mock.calls.filter(([key]) => key === 'recentRootsList');
    const recentRootsWrites = setItemMock.mock.calls.filter(([key]) => key === 'recentRootsList');
    expect(recentRootsReads).toHaveLength(1);
    expect(recentRootsWrites).toHaveLength(1);

    // Same final order a sequence of individual recordRecentRootIfNew calls
    // produced pre-fix: each new grant prepends, so restore order reverses.
    const recents = await registry.listRecentRoots();
    expect(recents.map((entry) => entry.path)).toEqual(['/ws/gamma', '/ws/beta', '/ws/alpha']);
  });

  it('quarantines a malformed ledger on the read path instead of bricking Recents', async () => {
    const registry = createRegistry({ storage });
    const corruptRaw = JSON.stringify([{ path: '/ws/alpha' }]);
    await storage.setItem('recentRootsList', corruptRaw);

    expect(await registry.listRecentRoots()).toEqual([]);
    expect(await storage.getItem('recentRootsList.corrupt')).toBe(corruptRaw);
    expect(await storage.getItem('recentRootsList')).toBeNull();
    expect(loggerMock.error).toHaveBeenCalledWith(
      QUARANTINE_MESSAGE,
      expect.objectContaining({ quarantineKey: 'recentRootsList.corrupt' })
    );
  });

  it('quarantines a malformed ledger on the record path and self-heals from the next grant', async () => {
    const registry = createRegistry({ storage });
    const corruptRaw = JSON.stringify([{ path: '/ws/alpha' }]);
    await storage.setItem('recentRootsList', corruptRaw);

    const descriptor = await registry.addRoot(rootHandle('/ws/beta'));

    expect(descriptor.permissionState).toBe('granted');
    expect(await storage.getItem('recentRootsList.corrupt')).toBe(corruptRaw);
    expect((await registry.listRecentRoots()).map((entry) => entry.path)).toEqual(['/ws/beta']);
    expect(loggerMock.error).toHaveBeenCalledWith(QUARANTINE_MESSAGE, expect.anything());
  });

  it('quarantines a malformed ledger on addRootByPath and rejects with the never-granted remedy', async () => {
    const registry = createRegistry({ storage });
    const corruptRaw = 'not json at all';
    await storage.setItem('recentRootsList', corruptRaw);

    await expect(registry.addRootByPath('/ws/alpha')).rejects.toThrow(
      'Folder was never granted in this app; use Add Folder to grant it.'
    );
    expect(await storage.getItem('recentRootsList.corrupt')).toBe(corruptRaw);
    expect(await storage.getItem('recentRootsList')).toBeNull();
    expect(loggerMock.error).toHaveBeenCalledWith(QUARANTINE_MESSAGE, expect.anything());
  });

  it('propagates a ledger read I/O failure rather than mistaking it for corruption', async () => {
    const registry = createRegistry({ storage });
    vi.mocked(storage.getItem).mockImplementation(async (key: string) => {
      if (key === 'recentRootsList') {
        throw new Error('storage offline');
      }
      return null;
    });

    await expect(registry.listRecentRoots()).rejects.toThrow('storage offline');
    expect(storage.setItem).not.toHaveBeenCalledWith('recentRootsList.corrupt', expect.anything());
    expect(loggerMock.error).not.toHaveBeenCalledWith(QUARANTINE_MESSAGE, expect.anything());
  });

  it('does not mount or persist a root when the recentRootsList read fails during addRoot (BST-1400 item 4)', async () => {
    const registry = createRegistry({ storage });
    vi.mocked(storage.getItem).mockImplementation(async (key: string) => {
      if (key === 'recentRootsList') {
        throw new Error('storage offline');
      }
      return null;
    });

    await expect(registry.addRoot(rootHandle('/ws/alpha'))).rejects.toThrow('storage offline');

    // The read is hoisted above the mount+persist mutation, so a rejected
    // addRoot() must leave rootsList untouched — before the fix, the mount
    // and rootsList persist both completed BEFORE this read ran, so the
    // caller saw a rejection for a call that had, in fact, already
    // succeeded.
    expect(storage.setItem).not.toHaveBeenCalledWith('rootsList', expect.anything());
  });

  it('reads the recentRootsList ledger only once per addRoot call (no double-read after the hoist)', async () => {
    const registry = createRegistry({ storage });
    const getItemMock = vi.mocked(storage.getItem);

    await registry.addRoot(rootHandle('/ws/alpha'));

    const recentRootsReads = getItemMock.mock.calls.filter(([key]) => key === 'recentRootsList');
    expect(recentRootsReads).toHaveLength(1);
  });

  it('tolerates a recentRootsList write failure without failing addRoot (accepted deviation)', async () => {
    const registry = createRegistry({ storage });
    const setItemMock = vi.mocked(storage.setItem);
    const originalSetItem = setItemMock.getMockImplementation();
    setItemMock.mockImplementation(async (key: string, value: string) => {
      if (key === 'recentRootsList') {
        throw new Error('disk full');
      }
      await originalSetItem?.(key, value);
    });

    const descriptor = await registry.addRoot(rootHandle('/ws/gamma'));

    expect(descriptor.permissionState).toBe('granted');
    expect(await registry.listRecentRoots()).toEqual([]);
    // The deviation is ACCEPTED, not silent: the dropped ledger write is
    // reported so a user who loses Recents has something to point at.
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Failed to record a recently granted workspace folder',
      expect.anything()
    );
  });
});

describe('resolveGrantedRootHandle managed-worktree gate (BST-1390, spec §6.2)', () => {
  it('accepts a path the managed-worktree authorizer claims, with an EMPTY recents ledger', async () => {
    const empty = createStorage();
    const handle = await resolveGrantedRootHandle(empty, '/managed/app/bright-fox', () =>
      Promise.resolve('authorized')
    );
    expect(handle).toMatchObject({
      grantSource: 'managed-worktree',
      handle: { kind: 'directory', path: '/managed/app/bright-fox' },
    });
  });

  it('still accepts a recents-granted path when the authorizer says no', async () => {
    const seeded = createStorage();
    await seeded.setItem(
      'recentRootsList',
      JSON.stringify([{ lastGrantedAt: 1, path: '/ws/alpha' }])
    );
    await expect(
      resolveGrantedRootHandle(seeded, '/ws/alpha', () => Promise.resolve('unmanaged'))
    ).resolves.toMatchObject({ grantSource: 'recents', handle: { path: '/ws/alpha' } });
  });

  it('uses the ordinary never-granted remedy for an unmanaged path', async () => {
    const empty = createStorage();
    await expect(
      resolveGrantedRootHandle(empty, '/somewhere/else', () => Promise.resolve('unmanaged'))
    ).rejects.toThrow('Folder was never granted in this app; use Add Folder to grant it.');
  });

  it('throws EXACTLY the canonical never-granted message the renderer refusal remedy matches on', async () => {
    const empty = createStorage();
    await expect(resolveGrantedRootHandle(empty, '/somewhere/else')).rejects.toMatchObject({
      message: WORKSPACE_ROOT_NEVER_GRANTED_MESSAGE,
    });
  });

  it('names the managed-worktree denial only for a path under the managed directory', async () => {
    const empty = createStorage();
    await expect(
      resolveGrantedRootHandle(empty, '/managed/app/not-a-row', () =>
        Promise.resolve('managed-but-unauthorized')
      )
    ).rejects.toThrow(
      'Folder was never granted in this app and is not a BrainStrike-managed worktree; use Add Folder to grant it.'
    );
  });

  it('throws EXACTLY the canonical managed-but-unauthorized message', async () => {
    const empty = createStorage();
    await expect(
      resolveGrantedRootHandle(empty, '/managed/app/not-a-row', () =>
        Promise.resolve('managed-but-unauthorized')
      )
    ).rejects.toMatchObject({ message: WORKSPACE_ROOT_MANAGED_BUT_UNAUTHORIZED_MESSAGE });
  });

  it('rejects when NO authorizer is injected and the ledger has no entry (unchanged behavior)', async () => {
    const empty = createStorage();
    await expect(resolveGrantedRootHandle(empty, '/somewhere/else')).rejects.toThrow(
      'Folder was never granted in this app'
    );
  });

  it('checks the LEDGER first so a throwing authorizer cannot break the recents path', async () => {
    const seeded = createStorage();
    await seeded.setItem(
      'recentRootsList',
      JSON.stringify([{ lastGrantedAt: 1, path: '/ws/alpha' }])
    );
    await expect(
      resolveGrantedRootHandle(seeded, '/ws/alpha', () => {
        throw new Error('authorizer exploded');
      })
    ).resolves.toMatchObject({ grantSource: 'recents', handle: { path: '/ws/alpha' } });
  });

  it('fails closed and logs when the managed-worktree authorizer throws', async () => {
    const empty = createStorage();
    const request = resolveGrantedRootHandle(empty, '/managed/app/bright-fox', () => {
      throw new Error('authorizer exploded');
    });

    await expect(request).rejects.toEqual(
      expect.objectContaining({
        cause: expect.objectContaining({ message: 'authorizer exploded' }),
        code: 'workspace.authorization-unavailable',
      })
    );
    await expect(request).rejects.toMatchObject({ failure: { kind: 'fault' } });
    expect(loggerMock.error).toHaveBeenCalledWith('managed-worktree authorization check threw', {
      error: expect.objectContaining({ message: 'authorizer exploded' }),
      path: '/managed/app/bright-fox',
    });
  });
});
