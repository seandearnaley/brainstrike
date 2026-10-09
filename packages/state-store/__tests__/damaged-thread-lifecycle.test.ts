// A thread whose stored rows fail verification must still list with honest dates and stay
// deletable, and a filtered hydration read returns only the rows a reader folds.
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
    expect(await store.threadTimes()).toEqual([{ threadId: 'a', ...appended }]);
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
    expect((await store.threadTimes()).map(({ threadId }) => threadId)).toEqual(['b']);
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

test('a hydration read skips streamed text but keeps tool calls, spooled chunks and every other row', async () => {
  const root = freshDir('hydration-read');
  const keep = { excludeStreamChunksExceptTypes: ['tool-call', 'tool-error'] } as const;
  await withStore(root, async (store) => {
    await store.append(
      [
        { event: { type: 'thread.started' }, threadId: 'a' },
        {
          event: { chunk: { delta: 'one', type: 'text-delta' }, type: 'stream.chunk' },
          threadId: 'a',
        },
        { event: { chunk: { type: 'tool-call' }, type: 'stream.chunk' }, threadId: 'a' },
        {
          event: { chunk: { delta: 'two', type: 'text-delta' }, type: 'stream.chunk' },
          threadId: 'a',
        },
        { event: { chunk: { type: 'tool-error' }, type: 'stream.chunk' }, threadId: 'a' },
        // A spooled row carries no inline chunk: the reader decides after decoding.
        { event: { blob: sha256Hex('x'), type: 'stream.chunk' }, threadId: 'a' },
        { event: { type: 'run.finished' }, threadId: 'a' },
      ].map((item, index) =>
        index === 5 ? { ...item, blobs: [{ content: 'x', hash: sha256Hex('x') }] } : item
      )
    );
    expect((await store.read('a', 1, 0, keep)).map(({ seq }) => seq)).toEqual([1, 3, 5, 6, 7]);
    expect((await store.read('a', 4, 0, keep)).map(({ seq }) => seq)).toEqual([5, 6, 7]);
  });
  // A skipped row is not damage the filtered read reports; a returned row's crc still is.
  damageRow(root, 'a', 2);
  await withStore(root, async (store) => {
    expect((await store.read('a', 1, 0, keep)).map(({ seq }) => seq)).toEqual([1, 3, 5, 6, 7]);
  });
  damageRow(root, 'a', 3);
  await withStore(root, async (store) => {
    await expect(store.read('a', 1, 0, keep)).rejects.toThrow(ThreadDamagedError);
  });
});

test('a hydration read reports a missing seq as damage', async () => {
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
    await expect(
      store.read('a', 1, 0, { excludeStreamChunksExceptTypes: ['tool-call'] })
    ).rejects.toThrow(ThreadDamagedError);
  });
});
