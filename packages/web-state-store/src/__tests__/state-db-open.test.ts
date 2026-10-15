import { RunLog } from '@brainstrike/state-store/run-log';
import { SCHEMA_VERSION } from '@brainstrike/state-store/schema';
import sqlite3InitModule, { type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { WEB_STATE_POOL_PREFIX, webStateNames } from '../protocol';
import { asBetterSqlite3, SqliteWasmDatabase } from '../sqlite-wasm-database';
import { openStateDb } from '../state-db-open';

let sqlite3: Sqlite3Static;

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

/** A file on the Node build's own file system, as the browser opens one in its pool. */
function opener(filename: string): (readOnly: boolean) => SqliteWasmDatabase {
  return (readOnly) =>
    new SqliteWasmDatabase(
      sqlite3,
      new sqlite3.oo1.DB({ filename, flags: readOnly ? 'r' : 'c' }),
      filename
    );
}

/** A healthy state DB holding `threads` threads of 40 rows each, checkpointed into the file. */
function seeded(filename: string, threads: number): Uint8Array {
  const { db } = openStateDb(opener(filename));
  const log = new RunLog(asBetterSqlite3(db), null);
  for (let t = 0; t < threads; t++) {
    log.append(
      Array.from({ length: 40 }, (_, n) => [
        `thread-${t}`,
        'text.delta',
        'run-1',
        JSON.stringify({ text: `row ${n} ${'x'.repeat(200)}`, type: 'text.delta' }),
        null,
        1,
      ]),
      1_700_000_000_000,
      true
    );
  }
  db.pragma('wal_checkpoint(TRUNCATE)');
  const bytes = sqlite3.capi.sqlite3_js_db_export(db.connection);
  db.close();
  return bytes;
}

function replaceFile(filename: string, bytes: Uint8Array): void {
  sqlite3.capi.sqlite3_js_vfs_create_file(0, filename, bytes);
}

describe('opening the state DB', () => {
  it('opens a healthy file read-write and brings it to the current schema', () => {
    const { damage, db } = openStateDb(opener('/healthy.db'));
    try {
      expect(damage).toBeNull();
      expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      expect(db.pragma('query_only', { simple: true })).toBe(0);
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      db.close();
    }
  });

  it('opens a file whose header is not a database read-only, and says so', () => {
    const bytes = seeded('/header.db', 1);
    bytes.fill(0x41, 0, 100);
    replaceFile('/header.db', bytes);

    const { damage, db } = openStateDb(opener('/header.db'));
    try {
      expect(damage).toMatch(/not a database|NOTADB/i);
      expect(db.pragma('query_only', { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  it('opens a file with a corrupted b-tree page read-only, says so and refuses writes', () => {
    const bytes = seeded('/page.db', 6);
    const pageSize = 4096;
    // Table b-tree leaves after page 1 (whose 100-byte file header precedes its page type).
    const leaves = Array.from({ length: bytes.length / pageSize }, (_, page) => page).filter(
      (page) => page > 0 && bytes[page * pageSize] === 0x0d
    );
    expect(leaves.length).toBeGreaterThan(2);
    const victim = leaves[Math.floor(leaves.length / 2)] as number;
    // A table leaf's page-type byte 0x0d becomes 0x00, as desktop's i3 corruption test does.
    bytes[victim * pageSize] = 0x00;
    replaceFile('/page.db', bytes);

    const { damage, db } = openStateDb(opener('/page.db'));
    try {
      expect(damage).toMatch(/.+/);
      expect(db.pragma('query_only', { simple: true })).toBe(1);
      const log = new RunLog(asBetterSqlite3(db), damage);
      expect(() =>
        log.append(
          [['thread-0', 'text.delta', 'run-1', '{"type":"text.delta"}', null, 1]],
          1,
          false
        )
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('store names', () => {
  it('derive the lock, channel, pool directory and VFS from one name', () => {
    expect(webStateNames('default')).toEqual({
      channel: `${WEB_STATE_POOL_PREFIX}default`,
      lock: `${WEB_STATE_POOL_PREFIX}default`,
      pool: `${WEB_STATE_POOL_PREFIX}default`,
      vfs: `${WEB_STATE_POOL_PREFIX}default`,
    });
  });

  it('refuse a name that is not a plain lowercase identifier', () => {
    for (const name of ['', 'Default', '../x', 'a/b', '-x', 'x'.repeat(64)]) {
      expect(() => webStateNames(name)).toThrow(RangeError);
    }
  });
});
