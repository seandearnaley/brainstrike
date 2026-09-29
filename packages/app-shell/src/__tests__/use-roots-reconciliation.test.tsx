import type { DbHandle } from '@brainstrike/db/react';
import type {
  FileSystemAdapter,
  GitInventory,
  GitResult,
  ManagedWorktreePathEntry,
  RootDescriptor,
} from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Asserting through the MOCKED logger rather than a live listener: the real
// logger writes the warnings these tests provoke to the console (noisy output
// in an otherwise pristine run) and raising the level to see them left the
// process-wide log level mutated for every suite that followed.
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => loggerMock,
}));

import { CHANGES_BRIDGE_REQUIRED_METHODS, type ChangesBridge } from '../changes/changes-bridge';
import {
  awaitRootRegistration,
  resetRootRegistrationEventsForTests,
} from '../roots/root-registration-events';
import { useRootsReconciliation } from '../roots/use-roots-reconciliation';
import type { WorktreesBridge } from '../worktrees/worktrees-bridge';

// Helper to build a RootDescriptor whose handle.path is `path`
function grantedRootWithPath(rootId: string, name: string, path: string): RootDescriptor {
  return {
    displayName: name,
    handle: { kind: 'directory', name, path, platform: 'electron' },
    kind: 'path',
    permissionState: 'granted',
    persisted: true,
    rootId,
  };
}

// A query stub that returns a pre-existing roots row so reconcileRoots maps
// the adapter rootId → the DB id ('db-root-id') via the path-match branch.
function makeDbWithRootRow(
  path: string,
  dbId: string
): { db: DbHandle; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (sql: string) => {
    if ((sql as string).includes('SELECT id')) {
      return { rows: [{ id: dbId, path }] };
    }
    return { rows: [] };
  });
  return { db: { query } as unknown as DbHandle, query };
}

function grantedRoot(rootId: string, name: string): RootDescriptor {
  return {
    displayName: name,
    handle: { kind: 'directory', name, path: name, platform: 'web' },
    kind: 'fsa',
    permissionState: 'granted',
    persisted: true,
    rootId,
  };
}

function makeAdapter(overrides: Partial<FileSystemAdapter> = {}): FileSystemAdapter {
  return overrides as FileSystemAdapter;
}

function makeDb(): { db: DbHandle; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
  return { db: { query } as unknown as DbHandle, query };
}

function managedWorktreeEntry(path: string): ManagedWorktreePathEntry {
  return {
    id: 'worktree-ledger-id',
    path,
  };
}
function installWorktreesBridgeWithManagedPaths(
  listManagedPaths: WorktreesBridge['listManagedPaths']
): () => void {
  window.worktrees = {
    adopt: vi.fn(),
    archive: vi.fn(),
    checkoutStatus: vi.fn(),
    create: vi.fn(),
    createBranchHere: vi.fn(),
    createContext: vi.fn(),
    getSettings: vi.fn(),
    inspectArchive: vi.fn(),
    list: vi.fn(),
    listManagedPaths,
    restore: vi.fn(),
    setSettings: vi.fn(),
  } satisfies WorktreesBridge;
  return () => {
    Reflect.deleteProperty(window, 'worktrees');
  };
}

function installWorktreesBridge(entries: readonly ManagedWorktreePathEntry[]): () => void {
  return installWorktreesBridgeWithManagedPaths(
    vi.fn(
      async (): Promise<GitResult<readonly ManagedWorktreePathEntry[]>> => ({
        ok: true,
        value: entries,
      })
    )
  );
}

describe('useRootsReconciliation', () => {
  // The mock is module-scoped, so every suite shares one spy: without this a
  // "was logged" assertion could pass on a call an earlier test made.
  beforeEach(() => {
    installWorktreesBridge([]);
    loggerMock.error.mockClear();
    loggerMock.warn.mockClear();
    resetRootRegistrationEventsForTests();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'worktrees');
  });

  it('no-ops when the adapter lacks restoreRoots', async () => {
    const adapter = makeAdapter();
    const { db, query } = makeDb();

    renderHook(() => useRootsReconciliation({ adapter, db }));

    await Promise.resolve();
    expect(query).not.toHaveBeenCalled();
  });

  it('no-ops when the db handle is null', async () => {
    const restoreRoots = vi.fn(async (): Promise<RootDescriptor[]> => []);
    const adapter = makeAdapter({ restoreRoots });

    renderHook(() => useRootsReconciliation({ adapter, db: null }));

    await Promise.resolve();
    expect(restoreRoots).not.toHaveBeenCalled();
  });

  it('runs reconciliation when adapter and db are both ready', async () => {
    const restoreRoots = vi.fn(
      async (): Promise<RootDescriptor[]> => [grantedRoot('root-1', 'docs')]
    );
    const adapter = makeAdapter({ restoreRoots });
    const { db, query } = makeDb();

    renderHook(() => useRootsReconciliation({ adapter, db }));

    await waitFor(() => {
      expect(restoreRoots).toHaveBeenCalledTimes(1);
      expect(query.mock.calls.some(([sql]) => (sql as string).includes('INSERT INTO roots'))).toBe(
        true
      );
    });
  });

  it('tags a managed worktree listed by the bridge during boot reconciliation', async () => {
    const worktreePath = '/managed/app/bright-fox';
    const uninstall = installWorktreesBridge([managedWorktreeEntry(worktreePath)]);
    try {
      const restoreRoots = vi.fn(
        async (): Promise<RootDescriptor[]> => [
          grantedRootWithPath('worktree-root', 'bright-fox', worktreePath),
        ]
      );
      const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
      const { db, query } = makeDb();

      const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

      await waitFor(() => {
        expect(result.current.dbRootKindByAdapterRootId.get('worktree-root')).toBe('worktree');
      });
      const insertCall = query.mock.calls.find(([sql]) =>
        (sql as string).includes('INSERT INTO roots')
      );
      expect(insertCall?.[1]?.[1]).toBe('worktree');
    } finally {
      uninstall();
    }
  });

  it('keeps boot reconciliation running when the worktree list rejects', async () => {
    const uninstall = installWorktreesBridgeWithManagedPaths(
      vi.fn(async (): Promise<GitResult<readonly ManagedWorktreePathEntry[]>> => {
        throw new Error('worktree service unavailable');
      })
    );
    try {
      const restoreRoots = vi.fn(
        async (): Promise<RootDescriptor[]> => [
          grantedRootWithPath('root-1', 'workspace', '/workspace/root'),
        ]
      );
      const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
      const { db, query } = makeDb();

      const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

      await waitFor(() => {
        expect(result.current.rootsReconciliationSettled).toBe(true);
      });
      expect(result.current.dbRootIdByAdapterRootId.get('root-1')).toBeUndefined();
      expect(query.mock.calls.some(([sql]) => (sql as string).includes('INSERT INTO roots'))).toBe(
        false
      );
      expect(loggerMock.warn).toHaveBeenCalledWith(
        'could not list managed worktrees; keeping the previous set',
        expect.objectContaining({ error: expect.any(Error) })
      );
      expect(loggerMock.warn).toHaveBeenCalledWith(
        'Deferring new root insert: managed worktree set is unknown',
        { rootId: 'root-1' }
      );
    } finally {
      uninstall();
    }
  });

  it('keeps boot reconciliation running when the worktree list returns ok false', async () => {
    const uninstall = installWorktreesBridgeWithManagedPaths(
      vi.fn(
        async (): Promise<GitResult<readonly ManagedWorktreePathEntry[]>> => ({
          error: 'worktree service unavailable',
          ok: false,
        })
      )
    );
    try {
      const restoreRoots = vi.fn(
        async (): Promise<RootDescriptor[]> => [
          grantedRootWithPath('root-1', 'workspace', '/workspace/root'),
        ]
      );
      const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
      const { db, query } = makeDb();

      const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

      await waitFor(() => {
        expect(result.current.rootsReconciliationSettled).toBe(true);
      });
      expect(result.current.dbRootIdByAdapterRootId.get('root-1')).toBeUndefined();
      expect(query.mock.calls.some(([sql]) => (sql as string).includes('INSERT INTO roots'))).toBe(
        false
      );
      expect(loggerMock.warn).toHaveBeenCalledWith(
        'could not list managed worktrees; keeping the previous set',
        { error: 'worktree service unavailable' }
      );
      expect(loggerMock.warn).toHaveBeenCalledWith(
        'Deferring new root insert: managed worktree set is unknown',
        { rootId: 'root-1' }
      );
    } finally {
      uninstall();
    }
  });

  it('restores an existing row to live when the first managed-path listing fails', async () => {
    const rootPath = '/workspace/root';
    const uninstall = installWorktreesBridgeWithManagedPaths(
      vi.fn(async (): Promise<GitResult<readonly ManagedWorktreePathEntry[]>> => {
        throw new Error('worktree service unavailable');
      })
    );
    try {
      const restoreRoots = vi.fn(
        async (): Promise<RootDescriptor[]> => [
          grantedRootWithPath('root-1', 'workspace', rootPath),
        ]
      );
      const query = vi.fn(async (sql: string) => {
        if (sql.includes('SELECT id, kind, path, status FROM roots')) {
          return {
            rows: [{ id: 'db-root-1', kind: 'path', path: rootPath, status: 'disconnected' }],
          };
        }
        return { rows: [] };
      });
      const db = { query } as unknown as DbHandle;
      const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });

      const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

      await waitFor(() => {
        expect(result.current.dbRootIdByAdapterRootId.get('root-1')).toBe('db-root-1');
      });
      expect(query).toHaveBeenCalledWith(
        `UPDATE roots SET status = 'live', last_verified_at = NOW() WHERE id = $1`,
        ['db-root-1']
      );
    } finally {
      uninstall();
    }
  });

  it('inserts a deferred root with the correct kind after managed-path listing recovers', async () => {
    const rootPath = '/managed/app/bright-fox';
    const listManagedPaths = vi
      .fn<WorktreesBridge['listManagedPaths']>()
      .mockRejectedValueOnce(new Error('worktree service unavailable'))
      .mockResolvedValueOnce({ ok: true, value: [managedWorktreeEntry(rootPath)] });
    const uninstall = installWorktreesBridgeWithManagedPaths(listManagedPaths);
    try {
      const descriptor = grantedRootWithPath('root-1', 'bright-fox', rootPath);
      const restoreRoots = vi.fn(async (): Promise<RootDescriptor[]> => [descriptor]);
      const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
      const { db, query } = makeDb();
      const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

      await waitFor(() => {
        expect(result.current.rootsReconciliationSettled).toBe(true);
      });
      expect(result.current.dbRootIdByAdapterRootId.get(descriptor.rootId)).toBeUndefined();

      await act(async () => {
        await result.current.registerRoot(descriptor);
      });

      expect(result.current.dbRootIdByAdapterRootId.get(descriptor.rootId)).toBe(descriptor.rootId);
      const insertCall = query.mock.calls.find(([sql]) =>
        (sql as string).includes('INSERT INTO roots')
      );
      expect(insertCall?.[1]?.[1]).toBe('worktree');
    } finally {
      uninstall();
    }
  });

  it('runs exactly once even when rerendered with a new adapter identity', async () => {
    const firstRestoreRoots = vi.fn(async (): Promise<RootDescriptor[]> => []);
    const secondRestoreRoots = vi.fn(async (): Promise<RootDescriptor[]> => []);
    const { db } = makeDb();

    const { rerender } = renderHook(
      ({ adapter }: { adapter: FileSystemAdapter }) => useRootsReconciliation({ adapter, db }),
      { initialProps: { adapter: makeAdapter({ restoreRoots: firstRestoreRoots }) } }
    );

    await waitFor(() => {
      expect(firstRestoreRoots).toHaveBeenCalledTimes(1);
    });

    rerender({ adapter: makeAdapter({ restoreRoots: secondRestoreRoots }) });

    await Promise.resolve();
    expect(firstRestoreRoots).toHaveBeenCalledTimes(1);
    expect(secondRestoreRoots).not.toHaveBeenCalled();
  });

  it('logs at error level and swallows when restoreRoots rejects', async () => {
    const restoreRoots = vi.fn(async (): Promise<RootDescriptor[]> => {
      throw new Error('handle store unavailable');
    });
    const adapter = makeAdapter({ restoreRoots });
    const { db, query } = makeDb();

    renderHook(() => useRootsReconciliation({ adapter, db }));

    await waitFor(() => {
      expect(loggerMock.error).toHaveBeenCalledWith(
        'Root reconciliation failed',
        expect.anything()
      );
    });
    expect(query).not.toHaveBeenCalled();
  });

  // (f) resolveDbRootId resolves to the db id for a known path after reconciliation
  it('resolveDbRootId resolves to the db root id for a known path after reconciliation completes', async () => {
    const rootPath = '/workspace/docs';
    const dbId = 'db-root-id';
    const restoreRoots = vi.fn(
      async (): Promise<RootDescriptor[]> => [
        grantedRootWithPath('adapter-root-1', 'docs', rootPath),
      ]
    );
    const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
    const { db } = makeDbWithRootRow(rootPath, dbId);

    const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

    // Wait for reconciliation to complete
    await waitFor(() => {
      expect(restoreRoots).toHaveBeenCalledTimes(1);
    });

    const resolved = await result.current.resolveDbRootId(rootPath);
    expect(resolved).toBe(dbId);
  });

  it('resolves same-named FSA roots by adapter root id instead of path', async () => {
    const restoreRoots = vi.fn(
      async (): Promise<RootDescriptor[]> => [
        grantedRoot('adapter-root-a', 'project'),
        grantedRoot('adapter-root-b', 'project'),
      ]
    );
    const adapter = makeAdapter({ platform: 'web' as const, restoreRoots });
    const { db } = makeDb();

    const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

    await waitFor(() => {
      expect(restoreRoots).toHaveBeenCalledTimes(1);
    });

    await expect(result.current.resolveDbRootId('project', 'adapter-root-a')).resolves.toBe(
      'adapter-root-a'
    );
    await expect(result.current.resolveDbRootId('project', 'adapter-root-b')).resolves.toBe(
      'adapter-root-b'
    );
  });

  // (g) resolveDbRootId resolves null and warns for an unknown path
  it('resolveDbRootId resolves null and warns for an unknown path', async () => {
    const restoreRoots = vi.fn(
      async (): Promise<RootDescriptor[]> => [
        grantedRootWithPath('adapter-root-1', 'docs', '/workspace/docs'),
      ]
    );
    const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
    const { db } = makeDbWithRootRow('/workspace/docs', 'db-root-id');

    const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

    await waitFor(() => {
      expect(restoreRoots).toHaveBeenCalledTimes(1);
    });

    const resolved = await result.current.resolveDbRootId('/unknown/path');
    expect(resolved).toBeNull();
    expect(
      loggerMock.warn.mock.calls.some(([message]) =>
        String(message).includes('no mapped db root id')
      )
    ).toBe(true);
  });

  // (h) when reconciliation rejected internally, resolveDbRootId still settles with null (no hang)
  it('resolveDbRootId still settles with null when restoreRoots throws, with no hang', async () => {
    const restoreRoots = vi.fn(async (): Promise<RootDescriptor[]> => {
      throw new Error('handle store unavailable');
    });
    const adapter = makeAdapter({ restoreRoots });
    const { db } = makeDb();

    const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

    // Even when reconciliation fails, this must resolve (not hang)
    let resolved: string | null = null;
    await act(async () => {
      resolved = await result.current.resolveDbRootId('/some/path');
    });
    expect(resolved).toBeNull();
  });

  // (i) regression: on first render db is null (DbProvider not ready yet). The
  // settling promise must NOT settle empty then — when db arrives on a later
  // render, the REAL mapping must come through (promises settle once, so an
  // early empty-settle would silently drop it and root_id would never be set).
  it('resolveDbRootId returns the real db id when db arrives after the first render', async () => {
    const rootPath = '/workspace/docs';
    const dbId = 'db-root-id';
    const restoreRoots = vi.fn(
      async (): Promise<RootDescriptor[]> => [
        grantedRootWithPath('adapter-root-1', 'docs', rootPath),
      ]
    );
    const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
    const { db } = makeDbWithRootRow(rootPath, dbId);

    const { rerender, result } = renderHook(
      ({ currentDb }: { currentDb: DbHandle | null }) =>
        useRootsReconciliation({ adapter, db: currentDb }),
      { initialProps: { currentDb: null as DbHandle | null } }
    );

    // db not ready yet: reconciliation must not have run.
    await Promise.resolve();
    expect(restoreRoots).not.toHaveBeenCalled();

    rerender({ currentDb: db });

    await waitFor(() => {
      expect(restoreRoots).toHaveBeenCalledTimes(1);
    });

    const resolved = await result.current.resolveDbRootId(rootPath);
    expect(resolved).toBe(dbId);
  });

  // (j) regression: an adapter WITHOUT restoreRoots settles the boot promise
  // empty. If a restoreRoots-capable adapter replaces it, the settling promise
  // must be re-keyed — promises settle once, so reusing the empty one would
  // silently drop the real mapping.
  it('resolveDbRootId returns the real db id after a restoreRoots-capable adapter replaces an incapable one', async () => {
    const rootPath = '/workspace/docs';
    const dbId = 'db-root-id';
    const restoreRoots = vi.fn(
      async (): Promise<RootDescriptor[]> => [
        grantedRootWithPath('adapter-root-1', 'docs', rootPath),
      ]
    );
    const incapableAdapter = makeAdapter();
    const capableAdapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
    const { db } = makeDbWithRootRow(rootPath, dbId);

    const { rerender, result } = renderHook(
      ({ currentAdapter }: { currentAdapter: FileSystemAdapter }) =>
        useRootsReconciliation({ adapter: currentAdapter, db }),
      { initialProps: { currentAdapter: incapableAdapter } }
    );

    // The incapable adapter settles the boot promise empty.
    const firstResolved = await result.current.resolveDbRootId(rootPath);
    expect(firstResolved).toBeNull();

    rerender({ currentAdapter: capableAdapter });

    await waitFor(() => {
      expect(restoreRoots).toHaveBeenCalledTimes(1);
    });

    // The fresh settling promise carries the real mapping.
    const resolved = await result.current.resolveDbRootId(rootPath);
    expect(resolved).toBe(dbId);
  });

  // BST-1400: the await-root-registration seam. `useWorkspaceBar` cannot read
  // this hook's own callbacks (it renders as a React sibling of the provider
  // that owns this hook instance — see `root-identity-context.tsx`), so boot
  // reconciliation must announce a successful mapping through the decoupled
  // `root-registration-events.ts` bus, keyed by BOTH identities a caller might
  // wait on.
  it('announces a boot-reconciled root through the root-registration seam', async () => {
    const rootPath = '/workspace/docs';
    const dbId = 'db-root-id';
    const restoreRoots = vi.fn(
      async (): Promise<RootDescriptor[]> => [
        grantedRootWithPath('adapter-root-1', 'docs', rootPath),
      ]
    );
    const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
    const { db } = makeDbWithRootRow(rootPath, dbId);

    renderHook(() => useRootsReconciliation({ adapter, db }));

    await waitFor(() => {
      expect(restoreRoots).toHaveBeenCalledTimes(1);
    });

    // Already announced by the time this waiter subscribes — resolves without
    // ever starting its bounded timeout. since: 0 is correct here — neither
    // key had registered before this test began.
    await expect(
      awaitRootRegistration(rootPath, { since: 0, timeoutMs: 100 })
    ).resolves.toBeUndefined();
    await expect(
      awaitRootRegistration('adapter-root-1', { since: 0, timeoutMs: 100 })
    ).resolves.toBeUndefined();
  });

  describe('registerRoot (mid-session registration)', () => {
    function countRootInserts(query: ReturnType<typeof vi.fn>): number {
      return query.mock.calls.filter(([sql]) => (sql as string).includes('INSERT INTO roots'))
        .length;
    }

    // (a) registerRoot adds a mapping visible via resolveDbRootId
    it('adds a mapping immediately visible through resolveDbRootId', async () => {
      const restoreRoots = vi.fn(async (): Promise<RootDescriptor[]> => []);
      const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
      const { db } = makeDb();
      const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

      await act(async () => {
        await result.current.registerRoot(
          grantedRootWithPath('root-new', 'docs', '/workspace/new')
        );
      });

      await expect(result.current.resolveDbRootId('/workspace/new')).resolves.toBe('root-new');
    });

    // BST-1400: this is the exact seam `useWorkspaceBar`'s "Add folder /
    // Recent" path now awaits instead of polling the database.
    it('announces a mid-session registerRoot through the root-registration seam', async () => {
      const restoreRoots = vi.fn(async (): Promise<RootDescriptor[]> => []);
      const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
      const { db } = makeDb();
      const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

      // Subscribed BEFORE registerRoot resolves, unlike the boot test above —
      // proves the seam wakes an already-waiting caller, not just a late one.
      const waiter = awaitRootRegistration('/workspace/new', { since: 0, timeoutMs: 1000 });

      await act(async () => {
        await result.current.registerRoot(
          grantedRootWithPath('root-new', 'docs', '/workspace/new')
        );
      });

      await expect(waiter).resolves.toBeUndefined();
    });

    it('tags a managed worktree listed by the bridge during mid-session registration', async () => {
      const worktreePath = '/managed/app/bright-fox';
      const uninstall = installWorktreesBridge([managedWorktreeEntry(worktreePath)]);
      try {
        const restoreRoots = vi.fn(async (): Promise<RootDescriptor[]> => []);
        const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
        const { db, query } = makeDb();
        const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

        await act(async () => {
          await result.current.registerRoot(
            grantedRootWithPath('worktree-root', 'bright-fox', worktreePath)
          );
        });

        const insertCall = query.mock.calls.find(([sql]) =>
          (sql as string).includes('INSERT INTO roots')
        );
        expect(insertCall?.[1]?.[1]).toBe('worktree');
        expect(result.current.dbRootKindByAdapterRootId.get('worktree-root')).toBe('worktree');
      } finally {
        uninstall();
      }
    });

    // (b) exactly one INSERT for a new path — including a repeated call
    it('issues exactly one INSERT for a new path, even when called twice', async () => {
      const restoreRoots = vi.fn(async (): Promise<RootDescriptor[]> => []);
      const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
      const { db, query } = makeDb();
      const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));
      const descriptor = grantedRootWithPath('root-new', 'docs', '/workspace/new');

      await act(async () => {
        await result.current.registerRoot(descriptor);
      });
      expect(countRootInserts(query)).toBe(1);

      await act(async () => {
        await result.current.registerRoot(descriptor);
      });
      expect(countRootInserts(query)).toBe(1);
    });

    // (c) skips unregistrable descriptors — same filter as reconcileRoots
    it('skips session-only and dead descriptors without writing to the DB', async () => {
      const restoreRoots = vi.fn(async (): Promise<RootDescriptor[]> => []);
      const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
      const { db, query } = makeDb();
      const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

      const sessionOnly: RootDescriptor = {
        ...grantedRootWithPath('root-session', 'session', '/workspace/session'),
        persisted: false,
      };
      const deadHandle: RootDescriptor = {
        ...grantedRootWithPath('root-dead', 'dead', '/workspace/dead'),
        permissionState: 'unknown',
      };

      await act(async () => {
        await result.current.registerRoot(sessionOnly);
        await result.current.registerRoot(deadHandle);
      });

      expect(countRootInserts(query)).toBe(0);
      await expect(result.current.resolveDbRootId('/workspace/session')).resolves.toBeNull();
      await expect(result.current.resolveDbRootId('/workspace/dead')).resolves.toBeNull();
    });

    // Boot reconcile wins races: a path the boot pass already mapped is never
    // re-inserted, and the boot mapping is preserved.
    it('does not re-insert a path the boot reconcile already mapped', async () => {
      const rootPath = '/workspace/docs';
      const dbId = 'db-root-id';
      const restoreRoots = vi.fn(
        async (): Promise<RootDescriptor[]> => [
          grantedRootWithPath('adapter-root-1', 'docs', rootPath),
        ]
      );
      const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
      const { db, query } = makeDbWithRootRow(rootPath, dbId);
      const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

      await act(async () => {
        await result.current.registerRoot(grantedRootWithPath('other-id', 'docs', rootPath));
      });

      expect(countRootInserts(query)).toBe(0);
      await expect(result.current.resolveDbRootId(rootPath)).resolves.toBe(dbId);
    });

    // The Add Folder commit fires registration and the sync loop in the same
    // render pass: a resolveDbRootId issued right after an UNAWAITED
    // registerRoot must still observe the new mapping (no NULL root_id race).
    it('resolveDbRootId issued right after an unawaited registerRoot sees the new mapping', async () => {
      const restoreRoots = vi.fn(async (): Promise<RootDescriptor[]> => []);
      const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
      const { db } = makeDb();
      const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

      let resolved: string | null = null;
      await act(async () => {
        void result.current.registerRoot(grantedRootWithPath('root-new', 'docs', '/workspace/new'));
        resolved = await result.current.resolveDbRootId('/workspace/new');
      });

      expect(resolved).toBe('root-new');
    });

    // Mirrors the boot no-op: on adapters without restoreRoots the registered
    // id could never be restored next session, so registering would orphan rows.
    it('no-ops on adapters without restoreRoots', async () => {
      const adapter = makeAdapter();
      const { db, query } = makeDb();
      const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

      await result.current.registerRoot(grantedRootWithPath('root-new', 'docs', '/workspace/new'));

      expect(query).not.toHaveBeenCalled();
    });
  });

  // BST-1397: the main-process git inventory arms its per-repo git-metadata
  // watchers ONLY inside a build, and builds only run from getSnapshot(). A
  // root whose `roots` row appears after app-ready therefore never gets a
  // watcher (and its Branch chip never live-updates) unless something calls
  // `changes.inventory()`. Root registration is that moment.
  describe('git inventory discovery refresh', () => {
    function okInventory(): ReturnType<typeof vi.fn> {
      return vi.fn(
        async (): Promise<GitResult<GitInventory>> => ({
          ok: true,
          value: { errors: [], repositories: [] },
        })
      );
    }

    /**
     * Installs a FULLY-formed `window.changes` (every method in
     * `CHANGES_BRIDGE_REQUIRED_METHODS` — a partial bridge resolves to null and
     * would make these assertions vacuous). Returns the uninstaller.
     */
    function installChangesBridge(inventory: ReturnType<typeof vi.fn>): () => void {
      const bridge: Record<string, unknown> = {};
      for (const method of CHANGES_BRIDGE_REQUIRED_METHODS) {
        bridge[method] = method === 'inventory' ? inventory : vi.fn();
      }
      window.changes = bridge as Partial<ChangesBridge>;
      return () => {
        Reflect.deleteProperty(window, 'changes');
      };
    }

    const REFRESH_FAILED = 'git inventory refresh after root registration failed';

    function warnedRefreshFailure(): boolean {
      return loggerMock.warn.mock.calls.some(([message]) => message === REFRESH_FAILED);
    }

    it('refreshes after a genuinely new boot insert, and again after a mid-session registerRoot', async () => {
      const inventory = okInventory();
      const uninstall = installChangesBridge(inventory);

      try {
        // No pre-existing row for ANY path (makeDb(), not makeDbWithRootRow):
        // the boot reconcile must INSERT this root, not match one.
        const restoreRoots = vi.fn(
          async (): Promise<RootDescriptor[]> => [
            grantedRootWithPath('adapter-root-1', 'docs', '/workspace/docs'),
          ]
        );
        const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
        const { db } = makeDb();
        const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

        await waitFor(() => {
          expect(inventory).toHaveBeenCalledTimes(1);
        });
        // FORCED, not a plain read: a TTL-cached or coalesced snapshot
        // predates the row just written, so the nudge would arm nothing.
        expect(inventory).toHaveBeenLastCalledWith({ maxAgeMs: 0 });

        await act(async () => {
          await result.current.registerRoot(
            grantedRootWithPath('root-new', 'new', '/workspace/new')
          );
        });

        await waitFor(() => {
          expect(inventory).toHaveBeenCalledTimes(2);
        });
        expect(inventory).toHaveBeenLastCalledWith({ maxAgeMs: 0 });
      } finally {
        uninstall();
      }
    });

    // BST-1400 item 11: the boot batch used to nudge whenever ANY root
    // successfully mapped, including one that only MATCHED an already-live
    // row — the ordinary case for every boot after the first. That row was
    // already discovered by the inventory's own eager app-ready build, so
    // re-nudging for it is one wasted extra build every session.
    it('does not refresh when the boot reconcile only MATCHED an already-registered root', async () => {
      const rootPath = '/workspace/docs';
      const inventory = okInventory();
      const uninstall = installChangesBridge(inventory);

      try {
        const restoreRoots = vi.fn(
          async (): Promise<RootDescriptor[]> => [
            grantedRootWithPath('adapter-root-1', 'docs', rootPath),
          ]
        );
        const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
        // makeDbWithRootRow: the row is ALREADY there before this boot runs —
        // reconciliation only matches and (if needed) restores it to 'live'.
        const { db } = makeDbWithRootRow(rootPath, 'db-root-id');
        const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

        // Awaits resolveDbRootId (not just restoreRoots having been CALLED) so
        // the full boot chain — including the conditional inventory nudge —
        // has settled before asserting it never fired; restoreRoots alone
        // only proves the chain STARTED.
        await expect(result.current.resolveDbRootId(rootPath)).resolves.toBe('db-root-id');
        expect(inventory).not.toHaveBeenCalled();
      } finally {
        uninstall();
      }
    });

    // BST-1400 item 11 review fold-in: a matched row that flips
    // 'disconnected' → 'live' is NOT "nothing new" — the inventory's query is
    // `WHERE status = 'live'` (workspace-roots.ts), so it was outside its
    // view a moment ago. Must nudge, same as a genuine insert.
    it('refreshes when the boot reconcile MATCHED a row and restored it from disconnected to live', async () => {
      const rootPath = '/workspace/docs';
      const inventory = okInventory();
      const uninstall = installChangesBridge(inventory);

      try {
        const restoreRoots = vi.fn(
          async (): Promise<RootDescriptor[]> => [
            grantedRootWithPath('adapter-root-1', 'docs', rootPath),
          ]
        );
        const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
        // Unlike makeDbWithRootRow's status-less fixture, this row is
        // explicitly 'disconnected' — reconcileRoots must flip it.
        const query = vi.fn(async (sql: string) => {
          if ((sql as string).includes('SELECT id')) {
            return { rows: [{ id: 'db-root-id', path: rootPath, status: 'disconnected' }] };
          }
          return { rows: [] };
        });
        const db = { query } as unknown as DbHandle;
        const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

        await expect(result.current.resolveDbRootId(rootPath)).resolves.toBe('db-root-id');
        await waitFor(() => {
          expect(inventory).toHaveBeenCalledTimes(1);
        });
        expect(inventory).toHaveBeenLastCalledWith({ maxAgeMs: 0 });
      } finally {
        uninstall();
      }
    });

    it('does not refresh when the boot reconcile registered no roots', async () => {
      const inventory = okInventory();
      const uninstall = installChangesBridge(inventory);

      try {
        const restoreRoots = vi.fn(async (): Promise<RootDescriptor[]> => []);
        const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
        const { db } = makeDb();
        const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

        await waitFor(() => {
          expect(restoreRoots).toHaveBeenCalledTimes(1);
        });
        await result.current.resolveDbRootId('/workspace/absent');
        expect(inventory).not.toHaveBeenCalled();
      } finally {
        uninstall();
      }
    });

    it('never touches a bridge on web, and reconciliation is unaffected', async () => {
      Reflect.deleteProperty(window, 'changes');

      const rootPath = '/workspace/docs';
      const restoreRoots = vi.fn(
        async (): Promise<RootDescriptor[]> => [
          grantedRootWithPath('adapter-root-1', 'docs', rootPath),
        ]
      );
      const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
      const { db } = makeDbWithRootRow(rootPath, 'db-root-id');
      const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

      await waitFor(() => {
        expect(result.current.dbRootIdByAdapterRootId.size).toBe(1);
      });
      await expect(result.current.resolveDbRootId(rootPath)).resolves.toBe('db-root-id');
      await act(async () => {
        await result.current.registerRoot(grantedRootWithPath('root-new', 'new', '/workspace/new'));
      });
      await expect(result.current.resolveDbRootId('/workspace/new')).resolves.toBe('root-new');

      // A bridge dereferenced without the null guard would throw into
      // performRootRegistration's catch — assert that never happened.
      expect(warnedRefreshFailure()).toBe(false);
      expect(loggerMock.error).not.toHaveBeenCalledWith(
        'Mid-session root registration failed',
        expect.anything()
      );
    });

    it('warns and leaves reconciliation intact when the refresh rejects', async () => {
      const inventory = vi.fn(async (): Promise<GitResult<GitInventory>> => {
        throw new Error('inventory unavailable');
      });
      const uninstall = installChangesBridge(inventory);

      try {
        const rootPath = '/workspace/docs';
        const restoreRoots = vi.fn(
          async (): Promise<RootDescriptor[]> => [
            grantedRootWithPath('adapter-root-1', 'docs', rootPath),
          ]
        );
        const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
        // makeDb() (not makeDbWithRootRow): must be a genuine INSERT — a
        // matched root never fires the nudge at all (see the item-11 test
        // above), which would make this failure-path test vacuous.
        const { db } = makeDb();
        const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

        await waitFor(() => {
          expect(result.current.dbRootIdByAdapterRootId.size).toBe(1);
        });
        await expect(result.current.resolveDbRootId(rootPath)).resolves.toBe('adapter-root-1');
        await waitFor(() => {
          expect(warnedRefreshFailure()).toBe(true);
        });
      } finally {
        uninstall();
      }
    });

    it('warns on a non-ok inventory result instead of dropping it', async () => {
      const inventory = vi.fn(
        async (): Promise<GitResult<GitInventory>> => ({ error: 'git not found', ok: false })
      );
      const uninstall = installChangesBridge(inventory);

      try {
        const rootPath = '/workspace/docs';
        const restoreRoots = vi.fn(
          async (): Promise<RootDescriptor[]> => [
            grantedRootWithPath('adapter-root-1', 'docs', rootPath),
          ]
        );
        const adapter = makeAdapter({ platform: 'electron' as const, restoreRoots });
        // Same reason as above: a genuine insert is required to trigger the
        // nudge this test exercises the failure path of.
        const { db } = makeDb();
        renderHook(() => useRootsReconciliation({ adapter, db }));

        await waitFor(() => {
          expect(warnedRefreshFailure()).toBe(true);
        });
      } finally {
        uninstall();
      }
    });
  });
});
