// A thread whose stored rows fail verification must still list with honest dates and stay
// deletable, and the hydration read returns every thread's marked rows in one writer round trip.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { ThreadDamagedError } from '../src/errors.js';
import { BLOBS_DIR, STATE_DB, StateStore, sha256Hex } from '../src/state-store.js';
import { cleanupDirs, freshDir, sleep } from './helpers/fs.js';
import { TruthIndexer } from './helpers/truth-indexer.js';

afterEach(() => cleanupDirs());

const baseline = (text: string) => ({ content: text, hash: sha256Hex(text) });

/** Rewrites one stored payload without its crc, the shape of an on-disk flip the crc catches. */
function damageRow(root: string, threadId: string, seq: number): void {
  const db = new Database(join(root, STATE_DB));
  try {
    const { payload } = db
      .prepare('SELECT payload FROM run_events WHERE thread_id = ? AND seq = ?')
      .get(threadId, seq) as { payload: string };
    db.prepare('UPDATE run_events SET payload = ? WHERE thread_id = ? AND seq = ?').run(
      payload.replace('"type":', '"type" :'),
      threadId,
      seq
    );
  } finally {
    db.close();
  }
}

async function withStore<T>(root: string, use: (store: StateStore) => Promise<T>): Promise<T> {
  const indexer = new TruthIndexer(root);
  const store = await StateStore.open(root, { indexer });
  try {
    return await use(store);
  } finally {
    try {
      await store.close();
    } finally {
      indexer.close();
    }
  }
}

test("a thread's catalog times are its first and latest append, even once a row is damaged", async () => {
  const root = freshDir('thread-times');
  const appended = await withStore(root, async (store) => {
    const first = await store.append([{ event: { type: 'thread.started' }, threadId: 'a' }]);
    await sleep(5);
    await store.append([{ event: { type: 'note' }, threadId: 'a' }]);
    await sleep(5);
    const last = await store.append([{ event: { type: 'note' }, threadId: 'a' }]);
    const rows = await store.read('a');
    expect(first.length + last.length).toBe(2);
    return { createdAt: rows[0]?.ts, updatedAt: rows[2]?.ts };
  });
  expect(appended.createdAt).toBeLessThan(appended.updatedAt ?? 0);
  damageRow(root, 'a', 2);
  await withStore(root, async (store) => {
    await expect(store.read('a')).rejects.toThrow(ThreadDamagedError);
    const [thread] = await store.readHydration();
    expect(thread).toMatchObject({ threadId: 'a', ...appended });
    expect(thread?.damage).toBeInstanceOf(ThreadDamagedError);
    expect(thread?.rows.map(({ seq }) => seq)).toEqual([1]);
  });
});

test('a crc-damaged thread deletes with its blobs and stays gone after a reopen', async () => {
  const root = freshDir('damaged-delete');
  const own = baseline('only the damaged thread keeps this baseline');
  await withStore(root, async (store) => {
    await store.append([
      { event: { type: 'thread.started' }, threadId: 'a' },
      { blobs: [own], event: { blobRefs: [own.hash], type: 'edit' }, threadId: 'a' },
      { event: { type: 'thread.started' }, threadId: 'b' },
    ]);
  });
  // The damaged row is the one holding the blob reference.
  damageRow(root, 'a', 2);
  await withStore(root, async (store) => {
    await expect(store.read('a')).rejects.toThrow(ThreadDamagedError);
    expect(await store.deleteThread('a')).toEqual([own.hash]);
    expect(existsSync(join(root, BLOBS_DIR, own.hash))).toBe(false);
  });
  await withStore(root, async (store) => {
    expect(await store.threads()).toEqual(['b']);
    expect((await store.readHydration()).map(({ threadId }) => threadId)).toEqual(['b']);
  });
});

test('collection keeps a blob a damaged thread still references', async () => {
  const root = freshDir('damaged-gc');
  const shared = baseline('a healthy and a damaged thread both keep this baseline');
  await withStore(root, async (store) => {
    await store.append([
      { blobs: [shared], event: { blobRefs: [shared.hash], type: 'edit' }, threadId: 'healthy' },
      { blobs: [shared], event: { blobRefs: [shared.hash], type: 'edit' }, threadId: 'damaged' },
      { event: { type: 'note' }, threadId: 'damaged' },
    ]);
  });
  damageRow(root, 'damaged', 2);
  await withStore(root, async (store) => {
    // The damaged thread's reference is invisible to a verified count, yet it holds the blob.
    expect(await store.deleteThread('healthy')).toEqual([]);
    expect(readFileSync(join(root, BLOBS_DIR, shared.hash), 'utf8')).toBe(shared.content);
    expect(await store.deleteThread('damaged')).toEqual([shared.hash]);
    expect(existsSync(join(root, BLOBS_DIR, shared.hash))).toBe(false);
  });
});

test('a held collection defers unlinking until its release', async () => {
  const root = freshDir('held-gc');
  const own = baseline('collected only once the hold is released');
  await withStore(root, async (store) => {
    await store.append([
      { blobs: [own], event: { blobRefs: [own.hash], type: 'edit' }, threadId: 'a' },
    ]);
    const release = store.holdBlobGc();
    expect(await store.deleteThread('a')).toEqual([]);
    expect(existsSync(join(root, BLOBS_DIR, own.hash))).toBe(true);
    await release();
    expect(existsSync(join(root, BLOBS_DIR, own.hash))).toBe(false);
  });
});

const seqs = (thread: { rows: readonly { seq: number }[] } | undefined): number[] =>
  (thread?.rows ?? []).map(({ seq }) => seq);

test('the hydration read returns each thread its marked rows only, across a reopen', async () => {
  const root = freshDir('hydration-read');
  await withStore(root, async (store) => {
    await store.append([
      { event: { type: 'thread.started' }, threadId: 'a' },
      { event: { type: 'thread.started' }, threadId: 'b' },
      {
        event: { chunk: { type: 'text-delta' }, type: 'stream.chunk' },
        hydrate: false,
        threadId: 'a',
      },
      { event: { chunk: { type: 'tool-call' }, type: 'stream.chunk' }, threadId: 'a' },
      {
        event: { chunk: { type: 'text-delta' }, type: 'stream.chunk' },
        hydrate: false,
        threadId: 'a',
      },
      { event: { type: 'run.finished' }, threadId: 'a' },
    ]);
    // Every row stays in the log; the mark only keeps a row out of the hydration read.
    expect((await store.read('a')).map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 5]);
  });
  await withStore(root, async (store) => {
    const threads = await store.readHydration();
    expect(threads.map(({ threadId }) => threadId)).toEqual(['a', 'b']);
    expect(seqs(threads[0])).toEqual([1, 3, 5]);
    expect(seqs(threads[1])).toEqual([1]);
    expect(threads.every((thread) => thread.damage === undefined)).toBe(true);
    expect(threads[0]?.rows[1]?.event).toEqual({
      chunk: { type: 'tool-call' },
      seq: 3,
      type: 'stream.chunk',
    });
  });
});

test('the hydration read verifies every row it returns, and one damaged thread spares the rest', async () => {
  const root = freshDir('hydration-damage');
  await withStore(root, async (store) => {
    await store.append([
      { event: { type: 'thread.started' }, threadId: 'a' },
      {
        event: { chunk: { type: 'text-delta' }, type: 'stream.chunk' },
        hydrate: false,
        threadId: 'a',
      },
      { event: { type: 'note' }, threadId: 'a' },
      { event: { type: 'note' }, threadId: 'a' },
      { event: { type: 'thread.started' }, threadId: 'b' },
    ]);
  });
  // An unmarked row is not read here; the full verification (a read, the first append) still finds it.
  damageRow(root, 'a', 2);
  await withStore(root, async (store) => {
    const [a] = await store.readHydration();
    expect(a?.damage).toBeUndefined();
    expect(seqs(a)).toEqual([1, 3, 4]);
    await expect(store.read('a')).rejects.toThrow(ThreadDamagedError);
  });
  damageRow(root, 'a', 3);
  await withStore(root, async (store) => {
    const [a, b] = await store.readHydration();
    expect(a?.damage).toBeInstanceOf(ThreadDamagedError);
    expect(a?.damage?.atSeq).toBe(3);
    expect(seqs(a)).toEqual([1]);
    expect(b?.damage).toBeUndefined();
    expect(seqs(b)).toEqual([1]);
  });
});

test('the hydration read reports a missing seq as damage', async () => {
  const root = freshDir('hydration-gap');
  await withStore(root, async (store) => {
    await store.append(
      ['thread.started', 'note', 'note'].map((type) => ({ event: { type }, threadId: 'a' }))
    );
  });
  const db = new Database(join(root, STATE_DB));
  db.prepare('DELETE FROM run_events WHERE thread_id = ? AND seq = 2').run('a');
  db.close();
  await withStore(root, async (store) => {
    const [a] = await store.readHydration();
    expect(a?.damage).toBeInstanceOf(ThreadDamagedError);
    expect(a?.damage?.atSeq).toBe(2);
    expect(seqs(a)).toEqual([1]);
  });
});
