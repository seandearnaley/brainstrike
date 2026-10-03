// M0-A2 item 3, S half (spike test/i3-corruption.test.ts): integrity_check, the per-row crc, and WAL torn tails. The J
// framing tests went with J. The "a rebuild records the gap in the derived store" half is PR 5's; here the read-only
// reader's explicit gap is asserted instead.
import {
  closeSync,
  copyFileSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { ThreadDamagedError, ThreadReadOnlyError } from '../src/errors.js';
import { readAll, SqliteReader } from '../src/sqlite-reader.js';
import { STATE_DB, StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { appendInputs, prose, rng, seedInputs } from './helpers/testkit.js';

afterEach(() => cleanupDirs());

function flipByte(file: string, at: number): void {
  const fd = openSync(file, 'r+');
  const b = Buffer.alloc(1);
  readSync(fd, b, 0, 1, at);
  b[0] = (b[0] as number) ^ 0x01;
  writeSync(fd, b, 0, 1, at);
  closeSync(fd);
}

async function sRoot(tag: string, n: number): Promise<string> {
  const root = freshDir(tag);
  const store = await StateStore.open(root);
  await appendInputs(store, 't1', seedInputs(n, 0, 61, 300));
  await store.close(); // a clean close checkpoints everything into state.db
  return root;
}

const gapsOf = (root: string): Array<{ from: number; to: number | null; reason: string }> => {
  const rd = new SqliteReader(root);
  try {
    return [...readAll(rd, 't1')].flatMap((i) =>
      i.kind === 'gap' ? [{ from: i.fromSeq, reason: i.reason, to: i.toSeq }] : []
    );
  } finally {
    rd.close();
  }
};

describe('item 3 · S integrity', () => {
  test("a flipped byte inside event N's payload: integrity_check says ok (SQLite has no content checksum); the per-row crc marks N damaged", async () => {
    const root = await sRoot('i3spay', 60);
    const db = join(root, STATE_DB);
    const pre = new Database(db, { readonly: true });
    const raw30 = (
      pre.prepare('SELECT payload FROM run_events WHERE thread_id = ? AND seq = 30').get('t1') as {
        payload: string;
      }
    ).payload;
    pre.close();
    const needle = Buffer.from(raw30.slice(60, 100));
    const file = readFileSync(db);
    const at = file.indexOf(needle);
    expect(at).toBeGreaterThan(0);
    expect(file.indexOf(needle, at + 1)).toBe(-1);
    flipByte(db, at + 5);
    const chk = new Database(db, { readonly: true });
    const integrity = chk.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const altered = (
      chk.prepare('SELECT payload FROM run_events WHERE thread_id = ? AND seq = 30').get('t1') as {
        payload: string;
      }
    ).payload;
    chk.close();
    expect(integrity).toEqual([{ integrity_check: 'ok' }]);
    expect(altered).not.toBe(raw30); // SQLite returns the altered bytes as if nothing happened
    const store = await StateStore.open(root);
    try {
      expect(store.health().stateDamage).toBeNull();
      expect(await store.status('t1')).toMatchObject({
        atSeq: 30,
        error: 'row crc mismatch',
        kind: 'damaged',
      });
      await expect(store.read('t1')).rejects.toThrow(ThreadDamagedError);
      await expect(appendInputs(store, 't1', [{ content: 'x', type: 'text' }])).rejects.toThrow(
        ThreadReadOnlyError
      );
      // A refusal does not fail the store: other threads still append.
      await appendInputs(store, 't2', [{ content: 'y', type: 'text' }]);
    } finally {
      await store.close();
    }
    expect(gapsOf(root)).toEqual([{ from: 30, reason: 'row crc mismatch', to: 30 }]);
  });

  test('a corrupted b-tree page: integrity_check fails; the store opens the state DB damaged and read-only, visibly', async () => {
    const root = await sRoot('i3spage', 400);
    const db = join(root, STATE_DB);
    const probe = new Database(db, { readonly: true });
    const pageSize = probe.pragma('page_size', { simple: true }) as number;
    const leaves = probe
      .prepare(
        "SELECT pageno FROM dbstat WHERE name = 'run_events' AND pagetype = 'leaf' ORDER BY pageno"
      )
      .all() as Array<{ pageno: number }>;
    probe.close();
    const victim = leaves[Math.floor(leaves.length / 2)]?.pageno as number;
    const fd = openSync(db, 'r+');
    writeSync(fd, Buffer.from([0x00]), 0, 1, (victim - 1) * pageSize); // page-type byte 0x0d (table leaf) -> 0x00
    closeSync(fd);
    const chk = new Database(db, { readonly: true });
    let integrity: string[];
    try {
      integrity = (chk.pragma('integrity_check') as Array<{ integrity_check: string }>).map(
        (r) => r.integrity_check
      );
    } catch (e) {
      integrity = [`threw ${(e as { code?: string }).code}: ${(e as Error).message}`];
    }
    chk.close();
    expect(integrity).not.toEqual(['ok']);
    const store = await StateStore.open(root);
    try {
      expect(store.health().stateDamage).toMatch(/.+/);
      expect((await store.status('t1')).kind).toBe('damaged');
      await expect(appendInputs(store, 't1', [{ content: 'x', type: 'text' }])).rejects.toThrow(
        ThreadReadOnlyError
      );
      await expect(store.read('t1')).rejects.toThrow(ThreadDamagedError);
    } finally {
      await store.close();
    }
    expect(gapsOf(root).length).toBeGreaterThan(0);
  });

  test('a corrupted index entry: quick_check says ok, integrity_check reports it, the store opens the state DB damaged', async () => {
    const root = await sRoot('i3sidx', 400);
    const db = join(root, STATE_DB);
    const probe = new Database(db, { readonly: true });
    const pageSize = probe.pragma('page_size', { simple: true }) as number;
    const leaf = (
      probe
        .prepare(
          "SELECT pageno FROM dbstat WHERE name = 'sqlite_autoindex_run_events_1' AND pagetype = 'leaf' ORDER BY pageno"
        )
        .get() as { pageno: number }
    ).pageno;
    probe.close();
    flipByte(db, (leaf - 1) * pageSize + pageSize - 3); // inside the last index cell on the page (an index key of an early row)
    const chk = new Database(db, { readonly: true });
    const quick = (chk.pragma('quick_check') as Array<{ quick_check: string }>).map(
      (r) => r.quick_check
    );
    const integrity = (chk.pragma('integrity_check') as Array<{ integrity_check: string }>).map(
      (r) => r.integrity_check
    );
    chk.close();
    expect(quick).toEqual(['ok']);
    expect(integrity.join(' ')).toMatch(/missing from index sqlite_autoindex_run_events_1/);
    const store = await StateStore.open(root);
    try {
      expect(store.health().stateDamage).toMatch(/missing from index/);
      expect((await store.status('t1')).kind).toBe('damaged');
      await expect(appendInputs(store, 't1', [{ content: 'x', type: 'text' }])).rejects.toThrow(
        ThreadReadOnlyError
      );
    } finally {
      await store.close();
    }
  });

  test('WAL torn at EVERY byte offset of the last commit: SQLite recovers to the previous commit (built in: WAL frame checksums)', () => {
    const dir = freshDir('i3swal');
    const db = new Database(join(dir, 'a.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('wal_autocheckpoint = 0');
    db.exec(
      'CREATE TABLE run_events(id INTEGER PRIMARY KEY, thread_id TEXT, seq INTEGER, payload TEXT, crc INTEGER, UNIQUE(thread_id, seq))'
    );
    const ins = db.prepare(
      'INSERT INTO run_events(thread_id, seq, payload, crc) VALUES (?, ?, ?, 0)'
    );
    const r = rng(71);
    for (let i = 1; i <= 49; i++) {
      ins.run('t1', i, prose(r, 300));
    }
    const size49 = statSync(join(dir, 'a.db-wal')).size;
    ins.run('t1', 50, prose(r, 300));
    const size50 = statSync(join(dir, 'a.db-wal')).size;
    copyFileSync(join(dir, 'a.db'), join(dir, 'base.db'));
    copyFileSync(join(dir, 'a.db-wal'), join(dir, 'base.db-wal'));
    db.close();
    let ok = 0;
    const fails: string[] = [];
    for (let cut = size49; cut <= size50; cut++) {
      const c = join(dir, 'c.db');
      rmSync(`${c}-shm`, { force: true });
      copyFileSync(join(dir, 'base.db'), c);
      copyFileSync(join(dir, 'base.db-wal'), `${c}-wal`);
      truncateSync(`${c}-wal`, cut);
      const x = new Database(c);
      const n = (x.prepare('SELECT count(*) AS n FROM run_events').get() as { n: number }).n;
      const ic = (x.pragma('quick_check') as Array<{ quick_check: string }>)[0]?.quick_check;
      x.close();
      const want = cut === size50 ? 50 : 49;
      if (n === want && ic === 'ok') {
        ok++;
      } else {
        fails.push(`cut=${cut - size49}: rows=${n} check=${ic}`);
      }
    }
    expect(fails).toEqual([]);
    expect(ok).toBe(size50 - size49 + 1);
  });
});
