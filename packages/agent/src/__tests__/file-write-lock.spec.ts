/**
 * Unit coverage for the per-file async write lock
 * (packages/agent/src/tools/file-write-lock.ts).
 *
 * Proves same-key tasks serialize (never overlap) while different-key tasks run
 * concurrently, that a rejecting task does not wedge or reject the next waiter,
 * and that THIS caller still sees its own result/rejection.
 */
import { describe, expect, it } from 'vitest';
import { withFileLock } from '../tools/file-write-lock';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('withFileLock', () => {
  it('serializes tasks for the SAME key (no overlap, submission order)', async () => {
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    const makeTask = (label: string) => async (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(`start:${label}`);
      // Yield several times to give any overlapping task a chance to interleave.
      await Promise.resolve();
      await Promise.resolve();
      events.push(`end:${label}`);
      active -= 1;
    };

    await Promise.all([
      withFileLock('/same', makeTask('a')),
      withFileLock('/same', makeTask('b')),
      withFileLock('/same', makeTask('c')),
    ]);

    // Never two tasks running at once on the same key...
    expect(maxActive).toBe(1);
    // ...and each task fully finished before the next started, in order.
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });

  it('runs tasks for DIFFERENT keys concurrently', async () => {
    const gateA = deferred<void>();
    const gateB = deferred<void>();
    let aStarted = false;
    let bStarted = false;

    const runA = withFileLock('/a', async () => {
      aStarted = true;
      // A only completes once B has also started — proving they overlap.
      await gateA.promise;
      return 'a';
    });
    const runB = withFileLock('/b', async () => {
      bStarted = true;
      await gateB.promise;
      return 'b';
    });

    // Let both tasks reach their gate.
    await Promise.resolve();
    expect(aStarted).toBe(true);
    expect(bStarted).toBe(true);

    gateA.resolve();
    gateB.resolve();
    expect(await Promise.all([runA, runB])).toEqual(['a', 'b']);
  });

  it('isolates a rejecting task: the next same-key waiter still runs and the rejection reaches its own caller', async () => {
    const order: string[] = [];

    const failing = withFileLock('/k', async () => {
      order.push('fail-start');
      await Promise.resolve();
      throw new Error('boom');
    });
    const following = withFileLock('/k', async () => {
      order.push('next-start');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('boom');
    // The following task was NOT rejected by the earlier failure and ran after it.
    await expect(following).resolves.toBe('ok');
    expect(order).toEqual(['fail-start', 'next-start']);
  });

  it('last-writer-consistent: serialized read-modify-write to one shared value applies BOTH updates without a lost update', async () => {
    // Simulates two concurrent edits to the same "file": each reads the shared
    // value, yields, then writes value + delta. Without the lock the second read
    // would observe the stale value and clobber the first edit (lost update).
    const store: { value: number } = { value: 0 };

    const edit = (delta: number) =>
      withFileLock('/file', async () => {
        const current = store.value; // read
        await Promise.resolve(); // yield (where a race would interleave)
        await Promise.resolve();
        store.value = current + delta; // write
      });

    await Promise.all([edit(3), edit(4)]);
    // Both edits applied: 0 + 3 + 4. A lost update would leave 3 or 4.
    expect(store.value).toBe(7);
  });
});
