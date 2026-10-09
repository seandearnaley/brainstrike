import type { DbHandle } from '@brainstrike/db/react';
import type { FileSystemAdapter, RootDescriptor } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => loggerMock,
}));

import { resetRootRegistrationEventsForTests } from '../roots/root-registration-events';
import { useRootsReconciliation } from '../roots/use-roots-reconciliation';

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
function makeAdapter(overrides: Partial<FileSystemAdapter>): FileSystemAdapter {
  return overrides as FileSystemAdapter;
}
function makeDbWithRootRow(path: string, id: string): { db: DbHandle } {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.startsWith('SELECT id') ? [{ id, kind: 'path', path, status: 'live' }] : [],
  }));
  return { db: { query } as unknown as DbHandle };
}
function makeDb(): { db: DbHandle } {
  return { db: { query: vi.fn(async () => ({ rows: [] })) } as unknown as DbHandle };
}
beforeEach(() => {
  vi.clearAllMocks();
  resetRootRegistrationEventsForTests();
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
    listManagedPaths: vi.fn(async () => ({ ok: true as const, value: [] })),
    restore: vi.fn(),
    setSettings: vi.fn(),
  };
});
afterEach(() => {
  Reflect.deleteProperty(window, 'worktrees');
  Reflect.deleteProperty(window, 'indexSearch');
});

describe('native root registration notification', () => {
  it('does not reconfigure a normal boot that only matches live roots', async () => {
    const root = grantedRootWithPath('native-root', 'native', '/workspace/native');
    const rootsRegistered = vi.fn(async () => {});
    Object.defineProperty(window, 'indexSearch', {
      configurable: true,
      value: { rootsRegistered },
    });
    const { db } = makeDbWithRootRow(root.handle.path, root.rootId);
    const adapter = makeAdapter({ platform: 'electron', restoreRoots: async () => [root] });
    try {
      const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));
      await act(async () => {
        await expect(result.current.resolveDbRootId(root.handle.path)).resolves.toBe(root.rootId);
      });
      expect(rootsRegistered).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(window, 'indexSearch');
    }
  });

  it('reports rejected activation while preserving the committed root', async () => {
    const root = grantedRootWithPath('native-root', 'native', '/workspace/native');
    const failure = new Error('Native writer unavailable');
    Object.defineProperty(window, 'indexSearch', {
      configurable: true,
      value: {
        rootsRegistered: vi.fn(async () => {
          throw failure;
        }),
      },
    });
    const { db } = makeDb();
    const adapter = makeAdapter({ platform: 'electron', restoreRoots: async () => [root] });
    try {
      const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));
      await act(async () => {
        await expect(result.current.resolveDbRootId(root.handle.path)).resolves.toBe(root.rootId);
      });
      await waitFor(() =>
        expect(loggerMock.error).toHaveBeenCalledWith(
          'Native index refresh after root registration failed',
          { error: failure }
        )
      );
    } finally {
      Reflect.deleteProperty(window, 'indexSearch');
    }
  });

  it.each(['boot', 'mid-session'] as const)(
    'notifies Main after the %s root write commits without waiting for native ingestion',
    async (phase) => {
      const root = grantedRootWithPath('native-root', 'native', '/workspace/native');
      const write = Promise.withResolvers<void>();
      const ingestion = Promise.withResolvers<void>();
      let committed = false;
      const rootsRegistered = vi.fn(() => {
        expect(committed).toBe(true);
        return ingestion.promise;
      });
      Object.defineProperty(window, 'indexSearch', {
        configurable: true,
        value: { rootsRegistered },
      });
      const query = vi.fn(async (sql: string) => {
        if (sql.startsWith('INSERT INTO roots')) {
          await write.promise;
          committed = true;
        }
        return { rows: [] };
      });
      const db = { query } as unknown as DbHandle;
      const adapter = makeAdapter({
        platform: 'electron',
        restoreRoots: async () => (phase === 'boot' ? [root] : []),
      });
      try {
        const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));
        let registration: Promise<void> | undefined;
        if (phase === 'mid-session') {
          await waitFor(() => expect(result.current.rootsReconciliationSettled).toBe(true));
          registration = result.current.registerRoot(root);
        }
        await waitFor(() =>
          expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO roots'))).toBe(true)
        );
        expect(rootsRegistered).not.toHaveBeenCalled();
        await act(async () => {
          write.resolve();
          await registration;
        });
        await waitFor(() => expect(rootsRegistered).toHaveBeenCalledExactlyOnceWith());
        await expect(result.current.resolveDbRootId(root.handle.path, root.rootId)).resolves.toBe(
          root.rootId
        );
        expect(result.current.rootsReconciliationSettled).toBe(true);
      } finally {
        write.resolve();
        ingestion.resolve();
        Reflect.deleteProperty(window, 'indexSearch');
      }
    }
  );
});
