import type { DbHandle } from '@brainstrike/db';
import type { FileSystemAdapter, RootDescriptor } from '@brainstrike/types';
import { addLogListener, LogLevel, type LogRecord, setLogLevel } from '@brainstrike/utils/logger';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRootsReconciliation } from '../roots/use-roots-reconciliation';

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
});
