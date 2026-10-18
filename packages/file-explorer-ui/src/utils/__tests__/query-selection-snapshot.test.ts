// @vitest-environment node
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

  it('writes TTL cleanup and all memberships in one parameterized statement', async () => {
    const db = createMockDb([
      (sql, params) => {
        expect(sql).toContain('DELETE FROM selection_snapshots');
        expect(sql).toContain('expires_at <= NOW()');
        expect(sql).toContain('INSERT INTO selection_snapshots');
        expect(sql).toContain('INSERT INTO selection_snapshot_files');
        expect(params).toEqual([24, ['/src/index.ts', '/src/utils.ts']]);
        return { rows: [{ id: 'snapshot-1' }] };
      },
    ]);
    await expect(
      createQuerySelectionSnapshot(db, ['/src/index.ts', '/src/utils.ts'])
    ).resolves.toBe('snapshot-1');
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('throws when snapshot creation does not return an id', async () => {
    const db = createMockDb([() => ({ rows: [] })]);
    await expect(createQuerySelectionSnapshot(db, ['/src/index.ts'])).rejects.toThrow(
      'Selection snapshot insert did not return an id'
    );
  });

  it('keeps concurrent writes serialized until a rejected statement physically settles', async () => {
    const pending = Promise.withResolvers<{ rows: { id: string }[] }>();
    const error = new Error('insert files failed');
    const db = createMockDb([() => pending.promise, () => ({ rows: [{ id: 'two' }] })]);
    const first = createQuerySelectionSnapshot(db, ['/src/index.ts']).catch((e: unknown) => e);
    const second = createQuerySelectionSnapshot(db, ['/src/utils.ts']);
    await vi.waitFor(() => expect(db.query).toHaveBeenCalledTimes(1));
    pending.reject(error);
    await expect(first).resolves.toBe(error);
    await expect(second).resolves.toBe('two');
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('releases the write lock after a timed-out snapshot write', async () => {
    vi.useFakeTimers();
    const db = createMockDb([
      () => new Promise(() => undefined),
      () => ({ rows: [{ id: 'snapshot-2' }] }),
    ]);
    const first = createQuerySelectionSnapshot(db, ['/src/index.ts']).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(first).resolves.toMatchObject({ message: 'Selection snapshot write timed out' });
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
