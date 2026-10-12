// M0-A2 item 1 (spike test/i1-purge.test.ts) on the state store: purge while streaming, blob refcount, crash during
// purge, and a reader pinning the WAL. The streaming purge runs here at 8 MB (the spike's mutation size); the 100 MB
// run is i1-purge-100mb.integration.test.ts. Not ported (PR 5, the indexer): "purge is serialized against a concurrent
// indexing pass" and the derived-store assertions, which need the real derived store.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { IndexerRequiredError } from '../src/errors.js';
import { TOMBSTONE_BODY, withSeq } from '../src/run-log-format.mjs';
import { CheckpointBlockedError } from '../src/sqlite-checkpoint.mjs';
import { readAll, SqliteReader } from '../src/sqlite-reader.js';
import { STATE_DB, StateStore, sha256Hex } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { fixture, killKids, type Proc, runTs } from './helpers/proc.js';
import { appendInputs, byteSearch, prose, rng, SECRET, seedInputs } from './helpers/testkit.js';
import { TruthIndexer } from './helpers/truth-indexer.js';
import { purgeWhileStreaming } from './suites/purge-while-streaming.js';

const T = 't1';
/** The child died at its crash point: SIGKILL on POSIX, TerminateProcess (a non-zero exit) on Windows. */
const expectKilled = (p: Proc): void => {
  expect(p.out()).not.toMatch(/crash point .* was not reached/);
  if (process.platform === 'win32') {
    expect(p.p.exitCode).not.toBe(0);
  } else {
    expect(p.p.signalCode).toBe('SIGKILL');
  }
};
afterEach(() => {
  killKids();
  cleanupDirs();
});

describe('item 1 · purge', () => {
  test('purge k from an 8 MB thread while it streams', async () => {
    const res = await purgeWhileStreaming(Number(process.env['STATE_STORE_THREAD_MB'] ?? '8'));
    process.stdout.write(`[i1 8MB] ${JSON.stringify(res)}\n`);
  }, 300_000);

  test('a blob shared with another event survives the purge (refcount)', async () => {
    const root = freshDir('i1blob');
    const indexer = new TruthIndexer(root);
    const store = await StateStore.open(root, { indexer });
    try {
      const shared = prose(rng(5), 13 * 1024);
      const [a, b] = await appendInputs(store, T, [
        { output: shared, type: 'tool-result' },
        { output: shared, type: 'tool-result' },
      ]);
      await indexer.catchUp([T]);
      const h = sha256Hex(shared);
      const rep = await store.purge(T, a as number);
      expect(rep.blobsDeleted).toEqual([]);
      expect(existsSync(join(root, 'blobs', h))).toBe(true);
      expect(JSON.parse((await store.read(T, b as number, 1))[0]?.raw ?? '{}')).toMatchObject({
        blob: h,
        type: 'tool-result',
      });
      await store.purge(T, b as number);
      expect(existsSync(join(root, 'blobs', h))).toBe(false);
    } finally {
      await store.close();
      indexer.close();
    }
  });

  test.each(['in-txn', 'after-truth'])(
    'SIGKILL at %s: truth is old-or-tombstoned (never torn); restart completes the purge',
    async (at) => {
      const root = freshDir('i1crash');
      const p = runTs(fixture('store-proc.ts'), ['crash-purge', root, at]);
      await p.line('seeded');
      await p.exit();
      expectKilled(p);
      // Inspect the truth read-only, before any store touches it.
      const reader = new SqliteReader(root);
      const items = [...readAll(reader, T)];
      reader.close();
      expect(items.map((i) => (i.kind === 'event' ? i.seq : `gap${i.fromSeq}`))).toEqual(
        Array.from({ length: 40 }, (_, i) => i + 1)
      );
      const k = items[19] as { raw: string };
      if (at === 'after-truth') {
        expect(k.raw).toBe(withSeq(20, TOMBSTONE_BODY));
      } else {
        expect(k.raw).toContain(SECRET);
      }
      expect(byteSearch(root, SECRET).total).toBeGreaterThan(0); // the blob still holds it
      const indexer = new TruthIndexer(root);
      const store = await StateStore.open(root, { indexer }); // breaks the dead process's stale lock, replays the intent
      try {
        expect(byteSearch(root, SECRET).total).toBe(0);
        const db = new Database(join(root, STATE_DB), { readonly: true });
        expect(db.prepare('SELECT count(*) FROM purge_intent').pluck().get()).toBe(0);
        db.close();
        const now = await store.read(T);
        expect(now.map((e) => e.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
        for (const [i, e] of now.entries()) {
          expect(e.raw).toBe(
            i === 19 ? withSeq(20, TOMBSTONE_BODY) : (items[i] as { raw: string }).raw
          );
        }
      } finally {
        await store.close();
        indexer.close();
      }
    },
    120_000
  );

  test('an interrupted purge is not silently skipped: opening without the indexer port refuses', async () => {
    const root = freshDir('i1noidx');
    const p = runTs(fixture('store-proc.ts'), ['crash-purge', root, 'after-truth']);
    await p.line('seeded');
    await p.exit();
    expectKilled(p);
    await expect(StateStore.open(root)).rejects.toThrow(IndexerRequiredError);
    expect(byteSearch(root, SECRET).total).toBeGreaterThan(0); // nothing was claimed done
  }, 120_000);

  test('S: a reader pinning the WAL makes the purge fail loudly; the retry completes it', async () => {
    const root = freshDir('i1pin');
    const indexer = new TruthIndexer(root);
    const store = await StateStore.open(root, { busyTimeoutMs: 300, indexer });
    try {
      await appendInputs(store, T, seedInputs(10, 5, 31));
      await indexer.catchUp([T]);
      const rd = new Database(join(root, STATE_DB), { readonly: true });
      rd.exec('BEGIN');
      rd.prepare('SELECT count(*) FROM run_events').get();
      await expect(store.purge(T, 5)).rejects.toThrow(CheckpointBlockedError);
      expect(byteSearch(root, SECRET).total).toBeGreaterThan(0); // the failure is real: old bytes are still in the files
      rd.exec('COMMIT');
      rd.close();
      await store.purge(T, 5);
      expect(byteSearch(root, SECRET).total).toBe(0);
    } finally {
      await store.close();
      indexer.close();
    }
  });

  test('an incomplete indexer refcount reply refuses purge success and retains the replay intent', async () => {
    const root = freshDir('i1counts');
    const indexer = new TruthIndexer(root);
    indexer.gcCheck = async () => ({});
    const store = await StateStore.open(root, { indexer });
    try {
      await appendInputs(store, T, seedInputs(3, 2));
      await expect(store.purge(T, 2)).rejects.toThrow(/reference count/);
      const db = new Database(join(root, STATE_DB), { readonly: true });
      try {
        expect(db.prepare('SELECT count(*) FROM purge_intent').pluck().get()).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      await store.close();
      indexer.close();
    }
  });

  test('purge and thread delete refuse loudly without the indexer port', async () => {
    const store = await StateStore.open(freshDir('i1port'));
    try {
      await appendInputs(store, T, seedInputs(3, 0));
      await expect(store.purge(T, 2)).rejects.toThrow(IndexerRequiredError);
      await expect(store.deleteThread(T)).rejects.toThrow(IndexerRequiredError);
    } finally {
      await store.close();
    }
  });
});
