// ADR-0031: the store's one writer never busy-waits on a reader. A reader pinning the WAL during a
// purge's TRUNCATE checkpoint is reported at once (the former busy_timeout waited 5 s first), and
// the purge's retry, its way forward, completes it once the reader ends.
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { CheckpointBlockedError } from '../src/sqlite-checkpoint.mjs';
import { STATE_DB, StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { appendInputs, byteSearch, SECRET, seedInputs } from './helpers/testkit.js';
import { TruthIndexer } from './helpers/truth-indexer.js';

const T = 'busy-reader-thread';

afterEach(() => {
  cleanupDirs();
});

test('a reader pinning the WAL fails the purge at once, and the retry completes it', async () => {
  const root = freshDir('purge-busy');
  const indexer = new TruthIndexer(root);
  const store = await StateStore.open(root, { indexer });
  try {
    await appendInputs(store, T, seedInputs(10, 5, 31));
    await indexer.catchUp([T]);
    const reader = new Database(join(root, STATE_DB), { readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM run_events').get();
    const started = performance.now();
    await expect(store.purge(T, 5)).rejects.toThrow(CheckpointBlockedError);
    expect(performance.now() - started).toBeLessThan(2000);
    reader.exec('COMMIT');
    reader.close();

    await store.purge(T, 5);
    expect(byteSearch(root, SECRET).total).toBe(0);
  } finally {
    await store.close();
    indexer.close();
  }
});
