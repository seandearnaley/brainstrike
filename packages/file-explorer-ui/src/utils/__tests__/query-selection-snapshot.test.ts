import type { DbHandle } from '@brainstrike/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createQuerySelectionSnapshot,
  loadQuerySelectionSnapshot,
  primeSerializedSnapshotWriteLockForTests,
  withSerializedSnapshotWrite,
} from '../query-selection-snapshot';

function createMockDb(
  implementations: Array<(sql: string, params?: unknown[]) => unknown>
): DbHandle {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const implementation = implementations.shift();
    if (!implementation) {
      throw new Error(`Unexpected query: ${sql}`);
    }
    return implementation(sql, params);
  });

  return {
    query,
  } as unknown as DbHandle;
}

describe('query-selection-snapshot', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates snapshots transactionally with TTL cleanup before insert', async () => {
    const db = createMockDb([
      (sql) => {
        expect(sql).toBe('BEGIN');
        return { rows: [] };
      },
      (sql) => {
        expect(sql).toContain('DELETE FROM selection_snapshots');
        expect(sql).toContain('expires_at <= NOW()');
        return { rows: [] };
      },
      (sql, params) => {
        expect(sql).toContain('INSERT INTO selection_snapshots');
        expect(sql).toContain("INTERVAL '1 hour'");
        expect(params).toEqual([24]);
        return { rows: [{ id: 'snapshot-1' }] };
      },
      (sql, params) => {
        expect(sql).toContain('INSERT INTO selection_snapshot_files');
        expect(params).toEqual(['snapshot-1', ['/src/index.ts', '/src/utils.ts']]);
        return { rows: [] };
      },
      (sql) => {
        expect(sql).toBe('COMMIT');
        return { rows: [] };
      },
    ]);

    const snapshotId = await createQuerySelectionSnapshot(db, ['/src/index.ts', '/src/utils.ts']);

    expect(snapshotId).toBe('snapshot-1');
  });

  it('resolves root-aware snapshots to the database root id before writing FK rows', async () => {
    const db = createMockDb([
      (sql) => {
        expect(sql).toBe('BEGIN');
        return { rows: [] };
      },
      () => ({ rows: [] }),
      () => ({ rows: [{ id: 'snapshot-root-a' }] }),
      (sql, params) => {
        expect(sql).toContain('FROM roots');
        expect(params).toEqual(['explorer-root-a', '/workspace/a']);
        return { rows: [{ id: 'db-root-a' }] };
      },
      (sql, params) => {
        expect(sql).toContain('INSERT INTO selection_snapshot_files');
        expect(sql).toContain('root_id');
        expect(params).toEqual(['snapshot-root-a', ['/src/shared.ts'], 'db-root-a']);
        return { rows: [] };
      },
      (sql) => {
        expect(sql).toBe('COMMIT');
        return { rows: [] };
      },
    ]);

    await expect(
      createQuerySelectionSnapshot(db, ['/src/shared.ts'], {
        rootId: 'explorer-root-a',
        rootPath: '/workspace/a',
      })
    ).resolves.toBe('snapshot-root-a');
  });

  it('throws when snapshot creation does not return an id', async () => {
    const db = createMockDb([
      (sql) => {
        expect(sql).toBe('BEGIN');
        return { rows: [] };
      },
      () => ({ rows: [] }),
      () => ({ rows: [] }),
      (sql) => {
        expect(sql).toBe('ROLLBACK');
        return { rows: [] };
      },
    ]);

    await expect(createQuerySelectionSnapshot(db, ['/src/index.ts'])).rejects.toThrow(
      'Selection snapshot insert did not return an id'
    );
  });

  it('rolls back when file path insertion fails after creating a snapshot row', async () => {
    const db = createMockDb([
      (sql) => {
        expect(sql).toBe('BEGIN');
        return { rows: [] };
      },
      () => ({ rows: [] }),
      () => ({ rows: [{ id: 'snapshot-1' }] }),
      () => {
        throw new Error('insert files failed');
      },
      (sql) => {
        expect(sql).toBe('ROLLBACK');
        return { rows: [] };
      },
    ]);

    await expect(createQuerySelectionSnapshot(db, ['/src/index.ts'])).rejects.toThrow(
      'insert files failed'
    );
  });

  it('serializes concurrent snapshot writes on a shared db handle', async () => {
    let activeTransaction = false;
    let nextSnapshotId = 1;
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === 'BEGIN') {
          expect(activeTransaction).toBe(false);
          activeTransaction = true;
          return { rows: [] };
        }

        if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          expect(activeTransaction).toBe(true);
          activeTransaction = false;
          return { rows: [] };
        }

        expect(activeTransaction).toBe(true);

        if (sql.includes('INSERT INTO selection_snapshots')) {
          return { rows: [{ id: `snapshot-${nextSnapshotId++}` }] };
        }

        if (sql.includes('INSERT INTO selection_snapshot_files')) {
          expect(Array.isArray(params?.[1])).toBe(true);
          await new Promise((resolve) => {
            setTimeout(resolve, 0);
          });
          return { rows: [] };
        }

        return { rows: [] };
      }),
    } as unknown as DbHandle;

    await expect(
      Promise.all([
        createQuerySelectionSnapshot(db, ['/src/index.ts']),
        createQuerySelectionSnapshot(db, ['/src/utils.ts']),
      ])
    ).resolves.toEqual(['snapshot-1', 'snapshot-2']);
  });

  it('keeps later snapshot writes serialized after an earlier write rejects', async () => {
    let insertFilesStarted = false;
    let allowFirstRollback = false;
    let secondInsertStartedBeforeRollback = false;
    let snapshotInsertCount = 0;

    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') {
          return { rows: [] };
        }
        if (sql === 'ROLLBACK') {
          expect(insertFilesStarted).toBe(true);
          while (!allowFirstRollback) {
            await new Promise((resolve) => {
              setTimeout(resolve, 0);
            });
          }
          return { rows: [] };
        }
        if (sql.includes('DELETE FROM selection_snapshots')) {
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO selection_snapshots')) {
          snapshotInsertCount += 1;
          return { rows: [{ id: snapshotInsertCount === 1 ? 'one' : 'two' }] };
        }
        if (sql.includes('INSERT INTO selection_snapshot_files')) {
          if (!insertFilesStarted) {
            insertFilesStarted = true;
            throw new Error('first write failed');
          }
          secondInsertStartedBeforeRollback = !allowFirstRollback;
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    } as unknown as DbHandle;

    const firstPromise = createQuerySelectionSnapshot(db, ['/src/index.ts']).catch(
      (error) => error
    );
    const secondPromise = createQuerySelectionSnapshot(db, ['/src/utils.ts']);

    await vi.waitFor(() => {
      expect(insertFilesStarted).toBe(true);
    });
    expect(secondInsertStartedBeforeRollback).toBe(false);

    allowFirstRollback = true;

    await expect(firstPromise).resolves.toBeInstanceOf(Error);
    await expect(secondPromise).resolves.toBe('two');
    expect(secondInsertStartedBeforeRollback).toBe(false);
  });

  it('releases the write lock after a timed-out snapshot write', async () => {
    vi.useFakeTimers();

    let insertFilesCallCount = 0;
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [] };
        }
        if (sql.includes('DELETE FROM selection_snapshots')) {
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO selection_snapshots')) {
          return { rows: [{ id: `snapshot-${insertFilesCallCount + 1}` }] };
        }
        if (sql.includes('INSERT INTO selection_snapshot_files')) {
          insertFilesCallCount += 1;
          if (insertFilesCallCount === 1) {
            return new Promise(() => undefined);
          }
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    } as unknown as DbHandle;

    const firstSnapshotPromise = createQuerySelectionSnapshot(db, ['/src/index.ts']);
    const handledTimeout = firstSnapshotPromise.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(handledTimeout).resolves.toBeInstanceOf(Error);
    await expect(handledTimeout).resolves.toMatchObject({
      message: 'Selection snapshot write timed out',
    });
    await expect(createQuerySelectionSnapshot(db, ['/src/utils.ts'])).resolves.toBe('snapshot-2');
  });

  it('releases the queued write lock when waiting on a prior lock times out', async () => {
    vi.useFakeTimers();

    const { promise: priorLock, resolve: releasePriorLock } = Promise.withResolvers<void>();
    const db = {
      query: vi.fn(),
    } as unknown as DbHandle;

    primeSerializedSnapshotWriteLockForTests(db, priorLock);

    const timedOutWrite = withSerializedSnapshotWrite(db, async () => 'first').catch(
      (error: unknown) => error
    );

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(timedOutWrite).resolves.toBeInstanceOf(Error);
    await expect(timedOutWrite).resolves.toMatchObject({
      message: 'Selection snapshot write lock timed out',
    });

    releasePriorLock();
    await Promise.resolve();

    await expect(withSerializedSnapshotWrite(db, async () => 'second')).resolves.toBe('second');
  });

  it('loads only non-expired snapshot rows', async () => {
    const db = createMockDb([
      (sql, params) => {
        expect(sql).toContain('JOIN selection_snapshots ss');
        expect(sql).toContain('ss.expires_at > NOW()');
        expect(params).toEqual(['snapshot-1']);
        return {
          rows: [{ file_path: '/src/utils.ts' }, { file_path: '/src/index.ts' }],
        };
      },
    ]);

    await expect(loadQuerySelectionSnapshot(db, 'snapshot-1')).resolves.toEqual([
      '/src/index.ts',
      '/src/utils.ts',
    ]);
  });
});
