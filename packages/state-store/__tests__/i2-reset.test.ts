// M0-A2 item 2 (spike test/i2-reset.test.ts): thread delete and factory reset. The spike's indexer was a second process
// whose handles lsof also checked; here the indexer's reader runs in this process (TruthIndexer), so lsof checks this
// process. The derived-row assertions (docs/vecs/refs per thread) belong to PR 5.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { RootLock } from '../src/lock.js';
import { StateStore, sha256Hex } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { fixture, killKids, runTs } from './helpers/proc.js';
import {
  appendInputs,
  byteSearch,
  HAS_LSOF,
  inodeOf,
  lsofUnder,
  SECRET,
  seedInputs,
} from './helpers/testkit.js';
import { TruthIndexer } from './helpers/truth-indexer.js';

afterEach(() => {
  killKids();
  cleanupDirs();
});

describe('item 2 · thread delete and factory reset', () => {
  test('thread delete: truth and blobs of the thread are gone; other threads intact', async () => {
    const root = freshDir('i2del');
    const indexer = new TruthIndexer(root);
    const store = await StateStore.open(root, { indexer });
    try {
      await appendInputs(store, 't1', seedInputs(30, 10, 41));
      await appendInputs(store, 't2', seedInputs(30, 0, 42));
      await indexer.catchUp(['t1', 't2']);
      const t2Before = (await store.read('t2')).map((e) => sha256Hex(e.raw));
      expect(byteSearch(root, SECRET).total).toBeGreaterThan(0);
      const hash = (JSON.parse((await store.read('t1', 10, 1))[0]?.raw ?? '{}') as { blob: string })
        .blob;
      expect(existsSync(join(root, 'blobs', hash))).toBe(true);

      const deleted = await store.deleteThread('t1');

      expect(deleted).toEqual([hash]);
      expect(await store.threads()).toEqual(['t2']);
      expect(existsSync(join(root, 'blobs', hash))).toBe(false);
      expect(byteSearch(root, SECRET).total).toBe(0);
      expect((await store.read('t2')).map((e) => sha256Hex(e.raw))).toEqual(t2Before);
      if (HAS_LSOF) {
        // No handle keeps the deleted thread's bytes alive (POSIX: an unlinked inode held open survives).
        for (const f of lsofUnder([process.pid], root).filter((x) => /^\d+$/.test(x.fd))) {
          expect(existsSync(f.name), `${f.name} still open`).toBe(true);
          expect(f.inode).toBe(inodeOf(f.name));
        }
      }
    } finally {
      await store.close();
      indexer.close();
    }
  });

  test('factory reset: the store entries are gone, the lock released and removed, and no handle stays open under the root (lsof on POSIX)', async () => {
    const root = freshDir('i2reset');
    const indexer = new TruthIndexer(root);
    const store = await StateStore.open(root, { indexer });
    await appendInputs(store, 't1', seedInputs(50, 10, 43));
    await appendInputs(store, 't2', seedInputs(50, 0, 44));
    await indexer.catchUp(['t1', 't2']);
    await store.purge('t1', 10);
    // positive control: the instrument sees this process's handles
    if (HAS_LSOF) {
      expect(lsofUnder([process.pid], root).length).toBeGreaterThan(0);
    }

    await store.reset();

    expect(readdirSync(root)).toEqual([]);
    if (HAS_LSOF) {
      expect(lsofUnder([process.pid], root)).toEqual([]);
    }
    expect(store.lock.isReleased).toBe(true);
    expect(RootLock.inspect(root)).toBeNull();
    // Released for real: another process takes the root at once.
    const p = runTs(fixture('store-proc.ts'), ['hold', root]);
    await p.line('holding');
    p.p.stdin?.write('close\n');
    await p.line('closed');
    await p.exit();
  });

  test('factory reset leaves entries of the root it did not create (the profile directory is shared)', async () => {
    const root = freshDir('i2share');
    mkdirSync(join(root, 'pgdata'));
    writeFileSync(join(root, 'pgdata', 'PG_VERSION'), '18');
    const store = await StateStore.open(root);
    await appendInputs(store, 't1', seedInputs(5, 2, 45));
    await store.reset();
    expect(readdirSync(root)).toEqual(['pgdata']);
    expect(byteSearch(root, SECRET).total).toBe(0);
  });
});
