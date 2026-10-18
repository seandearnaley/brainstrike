// @vitest-environment node
import { createDatabaseWorkScheduler, createScheduledDbHandle } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createQuerySelectionSnapshot,
  loadQuerySelectionSnapshot,
  primeSerializedSnapshotWriteLockForTests,
  SNAPSHOT_READ_TIMEOUT_MS,
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

  it('creates the snapshot, its files and the TTL cleanup in one atomic statement', async () => {
    const db = createMockDb([
      (sql, params) => {
        expect(sql).toContain('DELETE FROM selection_snapshots');
        expect(sql).toContain('expires_at <= NOW()');
        expect(sql).toContain('INSERT INTO selection_snapshots');
        expect(sql).toContain("INTERVAL '1 hour'");
        expect(sql).toContain('INSERT INTO selection_snapshot_files');
        expect(params).toEqual([24, ['/src/index.ts', '/src/utils.ts']]);
        return { rows: [{ id: 'snapshot-1' }] };
      },
    ]);

    const snapshotId = await createQuerySelectionSnapshot(db, ['/src/index.ts', '/src/utils.ts']);

    expect(snapshotId).toBe('snapshot-1');
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  // BST-2093: the background token indexer floods the shared scheduler with
  // foreground `file_token_cache` writes while a large Select All persists its
  // snapshot. Each statement of a BEGIN/…/COMMIT sequence re-queued behind that
  // flood (Select All timed out after 30s on hosted Linux), and the foreign
  // writes ran inside the snapshot's open transaction.
  it('keeps a concurrent foreground write out of the snapshot write', async () => {
    const concurrentSql = 'INSERT INTO file_token_cache (folder_id) VALUES ($1)';
    const executed: Array<'concurrent' | 'snapshot'> = [];
    let concurrentWrite: Promise<unknown> | null = null;
    const executor = {
      query: async <T = unknown>(sql: string) => {
        executed.push(sql === concurrentSql ? 'concurrent' : 'snapshot');
        // The concurrent writer submits as soon as the snapshot write starts.
        concurrentWrite ??= db.query(concurrentSql, ['folder-1']);
        return {
          rows: (sql.includes('INSERT INTO selection_snapshots')
            ? [{ id: 'snapshot-1' }]
            : []) as T[],
        };
      },
    };
    const db = createScheduledDbHandle(
      executor,
      createDatabaseWorkScheduler(),
      'foreground'
    ) as unknown as DbHandle;

    await expect(createQuerySelectionSnapshot(db, ['/src/index.ts'])).resolves.toBe('snapshot-1');
    await concurrentWrite;

    expect(executed.indexOf('concurrent')).toBeGreaterThan(executed.lastIndexOf('snapshot'));
  });

  it('throws when snapshot creation does not return an id', async () => {
    const db = createMockDb([() => ({ rows: [] })]);

    await expect(createQuerySelectionSnapshot(db, ['/src/index.ts'])).rejects.toThrow(
      'Selection snapshot insert did not return an id'
    );
  });

  it('surfaces a failed snapshot write without issuing another statement', async () => {
    const db = createMockDb([
      () => {
        throw new Error('insert files failed');
      },
    ]);

    await expect(createQuerySelectionSnapshot(db, ['/src/index.ts'])).rejects.toThrow(
      'insert files failed'
    );
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent snapshot writes on a shared db handle', async () => {
    let writesInFlight = 0;
    let nextSnapshotId = 1;
    const db = {
      query: vi.fn(async (_sql: string, params?: unknown[]) => {
        expect(writesInFlight).toBe(0);
        writesInFlight += 1;
        expect(Array.isArray(params?.[1])).toBe(true);
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
        writesInFlight -= 1;
        return { rows: [{ id: `snapshot-${nextSnapshotId++}` }] };
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
    let firstWriteStarted = false;
    let allowFirstFailure = false;
    let firstWriteSettled = false;
    let secondWriteStartedBeforeFirstSettled = false;

    const db = {
      query: vi.fn(async () => {
        if (!firstWriteStarted) {
          firstWriteStarted = true;
          while (!allowFirstFailure) {
            await new Promise((resolve) => {
              setTimeout(resolve, 0);
            });
          }
          firstWriteSettled = true;
          throw new Error('first write failed');
        }
        secondWriteStartedBeforeFirstSettled = !firstWriteSettled;
        return { rows: [{ id: 'two' }] };
      }),
    } as unknown as DbHandle;

    const firstPromise = createQuerySelectionSnapshot(db, ['/src/index.ts']).catch(
      (error) => error
    );
    const secondPromise = createQuerySelectionSnapshot(db, ['/src/utils.ts']);

    await vi.waitFor(() => {
      expect(firstWriteStarted).toBe(true);
    });
    expect(db.query).toHaveBeenCalledTimes(1);

    allowFirstFailure = true;

    await expect(firstPromise).resolves.toBeInstanceOf(Error);
    await expect(secondPromise).resolves.toBe('two');
    expect(secondWriteStartedBeforeFirstSettled).toBe(false);
  });

  it('releases the write lock after a timed-out snapshot write', async () => {
    vi.useFakeTimers();

    let writeCount = 0;
    const db = {
      query: vi.fn(async () => {
        writeCount += 1;
        if (writeCount === 1) {
          return new Promise(() => undefined);
        }
        return { rows: [{ id: `snapshot-${writeCount}` }] };
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

  it('times out a snapshot read that never settles', async () => {
    vi.useFakeTimers();
    const db = createMockDb([() => new Promise(() => undefined)]);

    const handledRead = loadQuerySelectionSnapshot(db, 'snapshot-1').catch(
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(SNAPSHOT_READ_TIMEOUT_MS);

    await expect(handledRead).resolves.toMatchObject({
      message: 'Selection snapshot read timed out',
    });
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
