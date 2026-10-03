// M0-A2 item 7, the truth half (spike test/i7-single-writer.test.ts): the store's writer is the only connection that
// writes the state DB; a reader in another process (the indexer's role) opens it read-only. The window half (a client
// that reads over IPC from seq N and then follows, never opening the root) belongs to the M3 host protocol and is not
// ported here.
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { readAll, SqliteReader } from '../src/sqlite-reader.js';
import { STATE_DB, StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir, sleep } from './helpers/fs.js';
import { fixture, killKids, runTs } from './helpers/proc.js';
import {
  appendInputs,
  HAS_LSOF,
  lsofUnder,
  type OpenFile,
  prose,
  rng,
  seedInputs,
} from './helpers/testkit.js';

const T = 't1';
afterEach(() => {
  killKids();
  cleanupDirs();
});

describe('item 7 · single writer', () => {
  test("the truth reader's connection is read-only", async () => {
    const root = freshDir('i7ro');
    const store = await StateStore.open(root);
    await appendInputs(store, T, seedInputs(5, 0, 71));
    const rd = new SqliteReader(root);
    try {
      expect([...readAll(rd, T)].length).toBe(5);
      const db = (rd as unknown as { db: Database.Database }).db;
      expect(db.readonly).toBe(true);
    } finally {
      rd.close();
      await store.close();
    }
  });

  test.skipIf(!HAS_LSOF)(
    'lsof: the writer holds the state DB read-write, the reader process holds it read-only, nobody else opens it (POSIX only)',
    async () => {
      const root = freshDir('i7');
      const store = await StateStore.open(root);
      try {
        await appendInputs(store, T, seedInputs(120, 0, 72));
        const reader = runTs(fixture('reader-proc.ts'), [root, T]);
        const readerPid = Number((await reader.line('reading')).split(' ')[1]);
        const samples: OpenFile[][] = [];
        const r = rng(7);
        const end = Date.now() + 1500;
        let next = Date.now();
        while (Date.now() < end) {
          await appendInputs(store, T, [{ content: prose(r, 120), type: 'text' }]);
          if (Date.now() >= next) {
            samples.push(lsofUnder([process.pid, readerPid], root));
            next = Date.now() + 150;
          }
          await sleep(1);
        }
        reader.p.stdin?.write('stop\n');
        expect(Number((await reader.line('read')).split(' ')[1])).toBeGreaterThan(120);
        await reader.exit();
        const flat = samples.flat();
        const real = realpathSync(root);
        const rel = (n: string): string => relative(real, n).split('\\').join('/');
        const dataFile = (f: OpenFile): boolean =>
          rel(f.name).endsWith(STATE_DB) && /^\d+$/.test(f.fd);
        expect(samples.length).toBeGreaterThan(3);
        // positive controls: the instrument sees both processes on the truth
        expect(flat.some((f) => f.pid === process.pid && dataFile(f))).toBe(true);
        expect(flat.some((f) => f.pid === readerPid && dataFile(f))).toBe(true);
        // The reader's truth DATA file is open read-only (SQLite's -wal/-shm are coordination files every reader maps).
        expect(
          flat.filter((f) => f.pid === readerPid && dataFile(f)).every((f) => f.mode === 'r')
        ).toBe(true);
        expect(
          flat.filter((f) => f.pid === process.pid && dataFile(f)).every((f) => f.mode === 'u')
        ).toBe(true);
        expect(flat.every((f) => [process.pid, readerPid].includes(f.pid))).toBe(true);
      } finally {
        await store.close();
      }
    }
  );
});
