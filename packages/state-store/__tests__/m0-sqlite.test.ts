// M0-A1 guards of the SQLite write path (spike test/m0-sqlite.test.ts): the writer worker's PRAGMAs, commit before
// deliver, the step-boundary op, and a failed or dead writer failing the store.
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import type { RunEvent } from '../src/run-log-types.js';
import { STATE_DB, StateStore, type StateStoreOptions, type SyncSpan } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(() => cleanupDirs());

const newRoot = (): string => join(freshDir('m0s'), 'store');
const ev = (text: string): RunEvent => ({
  message: { id: text, parts: [{ text, type: 'text' }], role: 'user' },
  type: 'ui.message',
});
const count = (path: string): number => {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare('SELECT count(*) FROM run_events').pluck().get() as number;
  } finally {
    db.close();
  }
};
const open = async (
  root: string,
  o: StateStoreOptions = {}
): Promise<{ s: StateStore; spans: SyncSpan[] }> => {
  const spans: SyncSpan[] = [];
  const s = await StateStore.open(root, { ...o, onSyncSpan: (x) => spans.push(x) });
  return { s, spans };
};

describe('M0-A1 S', () => {
  test('S-pragmas: WAL, synchronous=NORMAL, fullfsync on macOS, secure_delete, autocheckpoint off (checkpoint at boundaries)', async () => {
    const { s } = await open(newRoot());
    expect(s.settings).toMatchObject({
      fullfsync: process.platform === 'darwin' ? 1 : 0,
      journalMode: 'wal',
      secureDelete: 1,
      synchronous: 1,
      walAutocheckpoint: 0,
    });
    await s.close();
  });

  test('S-commit: onCommitted runs only after the batch is committed (visible to another connection)', async () => {
    const root = newRoot();
    const { s } = await open(root);
    const seen: number[] = [];
    const path = join(root, STATE_DB);
    await s.append(
      [
        { event: ev('a'), threadId: 't' },
        { event: ev('b'), threadId: 'u' },
      ],
      () => {
        seen.push(count(path));
      }
    );
    await s.append([{ event: ev('c'), threadId: 't' }], () => {
      seen.push(count(path));
    });
    expect(seen).toEqual([2, 3]);
    expect((await s.read('t')).map((r) => r.seq)).toEqual([1, 2]);
    await s.close();
  });

  test('S-boundary: the boundary op commits a marker for the thread at its latest seq and leaves synchronous=NORMAL', async () => {
    const root = newRoot();
    const { s, spans } = await open(root);
    await s.append([
      { event: ev('a'), threadId: 't' },
      { event: ev('b'), threadId: 't' },
    ]);
    await s.syncBoundary('t');
    expect(spans.map((x) => x.kind)).toEqual(['FULL commit']);
    const db = new Database(join(root, STATE_DB), { readonly: true });
    expect(db.prepare('SELECT thread_id, seq FROM run_sync').all()).toEqual([
      { seq: 2, thread_id: 't' },
    ]);
    db.close();
    await s.append([{ event: ev('c'), threadId: 't' }]);
    await s.close();
  });

  test('S-ckpt: once the WAL holds >= checkpointPages frames, the boundary op checkpoints (PASSIVE) before its FULL commit', async () => {
    const { s, spans } = await open(newRoot(), { checkpointPages: 8 });
    for (let i = 0; i < 20; i++) {
      await s.append([{ event: ev('x'.repeat(3000) + i), threadId: 't' }]);
    }
    await s.syncBoundary('t');
    expect(spans.map((x) => x.kind)).toEqual(['checkpoint(PASSIVE)+FULL commit']);
    const c = spans[0]?.checkpoint;
    expect(c?.before.log).toBeGreaterThanOrEqual(8);
    expect(c?.after.checkpointed).toBe(c?.after.log);
    await s.close();
  });

  test('S-failed: a failed append fails the store; later appends are refused', async () => {
    const { s } = await open(newRoot());
    await expect(
      s.append([{ event: ev('a'), threadId: null as unknown as string }])
    ).rejects.toThrow(/NOT NULL/);
    await expect(s.append([{ event: ev('b'), threadId: 't' }])).rejects.toThrow(/failed earlier/);
    await s.close().catch(() => undefined);
  });

  test('S-exit: if the writer worker dies, in-flight and later calls reject (no hang)', async () => {
    const { s } = await open(newRoot());
    const pending = s.append([{ event: ev('a'), threadId: 't' }]);
    await (s as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
    const settle = (p: Promise<unknown>): Promise<string> =>
      Promise.race([
        p.then(
          () => 'resolved',
          (e: Error) => `rejected: ${e.message}`
        ),
        new Promise<string>((r) => {
          setTimeout(() => r('hung'), 3000);
        }),
      ]);
    await expect(settle(pending)).resolves.toMatch(
      /^(resolved|rejected: StateStore writer worker exited)/
    );
    await expect(settle(s.append([{ event: ev('b'), threadId: 't' }]))).resolves.toMatch(
      /^rejected: StateStore failed earlier/
    );
  });
});
