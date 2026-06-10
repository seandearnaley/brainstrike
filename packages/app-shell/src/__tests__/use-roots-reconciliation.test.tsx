import type { DbHandle } from '@brainstrike/db';
import type { FileSystemAdapter, RootDescriptor } from '@brainstrike/types';
import { addLogListener, LogLevel, type LogRecord, setLogLevel } from '@brainstrike/utils/logger';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRootsReconciliation } from '../roots/use-roots-reconciliation';

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

describe('useRootsReconciliation', () => {
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
    setLogLevel(LogLevel.ERROR);
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (record.scope === 'useRootsReconciliation') {
        captured.push(record);
      }
    });

    try {
      const restoreRoots = vi.fn(async (): Promise<RootDescriptor[]> => {
        throw new Error('handle store unavailable');
      });
      const adapter = makeAdapter({ restoreRoots });
      const { db, query } = makeDb();

      renderHook(() => useRootsReconciliation({ adapter, db }));

      await waitFor(() => {
        expect(captured.some((record) => record.message === 'Root reconciliation failed')).toBe(
          true
        );
      });
      expect(query).not.toHaveBeenCalled();
    } finally {
      removeListener();
    }
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
    const adapter = makeAdapter({ restoreRoots, platform: 'electron' as const });
    const { db } = makeDbWithRootRow(rootPath, dbId);

    const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

    // Wait for reconciliation to complete
    await waitFor(() => {
      expect(restoreRoots).toHaveBeenCalledTimes(1);
    });

    const resolved = await result.current.resolveDbRootId(rootPath);
    expect(resolved).toBe(dbId);
  });

  // (g) resolveDbRootId resolves null and warns for an unknown path
  it('resolveDbRootId resolves null and warns for an unknown path', async () => {
    setLogLevel(LogLevel.WARN);
    const captured: LogRecord[] = [];
    const removeListener = addLogListener((record) => {
      if (record.scope === 'useRootsReconciliation') {
        captured.push(record);
      }
    });

    try {
      const restoreRoots = vi.fn(
        async (): Promise<RootDescriptor[]> => [
          grantedRootWithPath('adapter-root-1', 'docs', '/workspace/docs'),
        ]
      );
      const adapter = makeAdapter({ restoreRoots, platform: 'electron' as const });
      const { db } = makeDbWithRootRow('/workspace/docs', 'db-root-id');

      const { result } = renderHook(() => useRootsReconciliation({ adapter, db }));

      await waitFor(() => {
        expect(restoreRoots).toHaveBeenCalledTimes(1);
      });

      const resolved = await result.current.resolveDbRootId('/unknown/path');
      expect(resolved).toBeNull();
      expect(
        captured.some(
          (record) =>
            record.level === LogLevel.WARN &&
            (record.message as string).includes('no mapped db root id')
        )
      ).toBe(true);
    } finally {
      removeListener();
    }
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
    const resolved = await result.current.resolveDbRootId('/some/path');
    expect(resolved).toBeNull();
  });
});
