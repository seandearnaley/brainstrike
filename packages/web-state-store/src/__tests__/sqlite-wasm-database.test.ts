import { RunLog } from '@brainstrike/state-store/run-log';
import { crc32Bytes, verified } from '@brainstrike/state-store/run-log-format';
import { migrate, SCHEMA_VERSION } from '@brainstrike/state-store/schema';
import sqlite3InitModule, { type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import BetterSqlite3 from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqliteWasmDatabase } from '../sqlite-wasm-database';

let sqlite3: Sqlite3Static;

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

function wasm(): SqliteWasmDatabase {
  return new SqliteWasmDatabase(sqlite3, new sqlite3.oo1.DB(':memory:'), ':memory:');
}

/** The adapter where the shared modules expect a better-sqlite3 connection. */
function asDesktopDriver(db: SqliteWasmDatabase): BetterSqlite3.Database {
  return db as unknown as BetterSqlite3.Database;
}

/** The same work on both drivers. */
function both<T>(work: (db: BetterSqlite3.Database) => T): { desktop: T; web: T } {
  const desktop = new BetterSqlite3(':memory:');
  const web = wasm();
  try {
    return { desktop: work(desktop), web: work(asDesktopDriver(web)) };
  } finally {
    desktop.close();
    web.close();
  }
}

function caught(fn: () => unknown): { code?: unknown; name: string } {
  try {
    fn();
  } catch (error) {
    return { code: (error as { code?: unknown }).code, name: (error as Error).name };
  }
  throw new Error('expected a throw');
}

describe('the state DB schema on sqlite-wasm', () => {
  it('migrates to the same schema the desktop writer creates', () => {
    const { desktop, web } = both((db) => {
      migrate(db);
      return {
        objects: db
          .prepare(
            'SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema ORDER BY type, name'
          )
          .all(),
        presets: db.prepare('SELECT count(*) FROM view_filter_presets').pluck().get(),
        userVersion: db.pragma('user_version', { simple: true }),
      };
    });
    expect(web.userVersion).toBe(SCHEMA_VERSION);
    expect(web.objects.length).toBeGreaterThan(20);
    expect(web).toEqual(desktop);
  });
});

describe('the run log on sqlite-wasm', () => {
  const rows: Parameters<RunLog['append']>[0] = [
    ['thread-a', 'run.started', 'run-1', '{"type":"run.started","runId":"run-1"}', null, 1],
    ['thread-a', 'text.delta', 'run-1', '{"type":"text.delta","text":"héllo ✓ 𝄞"}', 3, 0],
    ['thread-b', 'run.started', 'run-2', '{"type":"run.started","runId":"run-2"}', null, 1],
    ['thread-a', 'run.finished', 'run-1', '{"type":"run.finished","runId":"run-1"}', null, 1],
  ];

  it('appends and reads back exactly as the desktop driver does', () => {
    const { desktop, web } = both((db) => {
      migrate(db);
      const log = new RunLog(db, null);
      const seqs = log.append(rows, 1_700_000_000_000, true);
      const more = log.append([rows[0] as (typeof rows)[number]], 1_700_000_000_500, false);
      return {
        check: log.check(),
        hydration: log.readHydration(),
        read: log.readFrom('thread-a', 2, 10),
        seqs: [...seqs, ...more],
        status: [log.status('thread-a'), log.status('thread-b'), log.status('missing')],
        threads: log.threads(),
      };
    });
    expect(web.seqs).toEqual([1, 2, 1, 3, 4]);
    expect(web.read.rows.every((row) => verified(row))).toBe(true);
    expect(web).toEqual(desktop);
  });

  it('marks a thread damaged when a stored payload no longer matches its crc', () => {
    const { desktop, web } = both((db) => {
      migrate(db);
      new RunLog(db, null).append(rows, 1_700_000_000_000, false);
      db.prepare("UPDATE run_events SET payload = replace(payload, 'héllo', 'hullo')").run();
      const log = new RunLog(db, null);
      return { read: log.readFrom('thread-a', 1, 10), status: log.status('thread-a') };
    });
    expect(web.status.kind).toBe('damaged');
    expect(web).toEqual(desktop);
  });
});

describe('the better-sqlite3 API subset', () => {
  it('reports run results, rows, plucked values and pragmas as better-sqlite3 does', () => {
    const { desktop, web } = both((db) => {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, size REAL, data BLOB)');
      const insert = db.prepare('INSERT INTO t (name, size, data) VALUES (?, ?, ?)');
      const runs = [
        insert.run('a', 1.5, Buffer.from([1, 2])),
        insert.run(['b', 2, null]),
        db.prepare('UPDATE t SET size = size * 2').run(),
      ];
      return {
        all: db.prepare('SELECT id, name, size FROM t ORDER BY id').all(),
        blob: [...(db.prepare('SELECT data FROM t WHERE id = 1').pluck().get() as Uint8Array)],
        get: db.prepare('SELECT name FROM t WHERE id = ?').get(2),
        iterate: [...db.prepare('SELECT name FROM t ORDER BY id').pluck().iterate()],
        missing: db.prepare('SELECT name FROM t WHERE id = ?').get(99),
        pragma: db.pragma('table_info(t)'),
        runs,
        simple: db.pragma('user_version', { simple: true }),
      };
    });
    expect(web).toEqual(desktop);
  });

  it('commits, rolls back and nests transactions as better-sqlite3 does', () => {
    const { desktop, web } = both((db) => {
      db.exec('CREATE TABLE t (v TEXT UNIQUE)');
      const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
      db.transaction(() => insert.run('kept'))();
      const outer = caught(() =>
        db.transaction(() => {
          insert.run('rolled back');
          throw new Error('abort');
        })()
      );
      db.transaction(() => {
        insert.run('outer');
        caught(() =>
          db.transaction(() => {
            insert.run('inner');
            insert.run('inner');
          })()
        );
      })();
      return {
        inTransaction: db.inTransaction,
        outer,
        values: db.prepare('SELECT v FROM t ORDER BY rowid').pluck().all(),
      };
    });
    expect(web.values).toEqual(['kept', 'outer']);
    expect(web).toEqual(desktop);
  });

  it('names constraint failures with the same extended result code', () => {
    const { desktop, web } = both((db) => {
      db.exec('CREATE TABLE t (v TEXT PRIMARY KEY, n INTEGER NOT NULL)');
      db.prepare('INSERT INTO t VALUES (?, ?)').run('x', 1);
      return [
        caught(() => db.prepare('INSERT INTO t VALUES (?, ?)').run('x', 2)).code,
        caught(() => db.prepare('INSERT INTO t VALUES (?, ?)').run('y', null)).code,
      ];
    });
    expect(web).toEqual(['SQLITE_CONSTRAINT_PRIMARYKEY', 'SQLITE_CONSTRAINT_NOTNULL']);
    expect(web).toEqual(desktop);
  });

  it('refuses the values better-sqlite3 refuses to bind', () => {
    const { desktop, web } = both((db) => {
      db.exec('CREATE TABLE t (v)');
      const insert = db.prepare('INSERT INTO t VALUES (?)');
      return [caught(() => insert.run(true)).name, caught(() => insert.run({ v: 1 })).name];
    });
    expect(web).toEqual(['TypeError', 'RangeError']);
    expect(web).toEqual(desktop);
  });

  it('keeps a statement usable when the same SQL is used inside its own iteration', () => {
    const db = wasm();
    try {
      db.exec('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1), (2), (3)');
      const sql = 'SELECT v FROM t WHERE v >= ? ORDER BY v';
      const pairs = [...db.prepare(sql).pluck().iterate(1)].map((v) => [
        v,
        db.prepare(sql).pluck().all(v),
      ]);
      expect(pairs).toEqual([
        [1, [1, 2, 3]],
        [2, [2, 3]],
        [3, [3]],
      ]);
    } finally {
      db.close();
    }
  });
});

describe('the run log crc', () => {
  it("is zlib's crc32 of the payload's UTF-8 bytes", () => {
    expect(crc32Bytes(new TextEncoder().encode('123456789'))).toBe(0xcb_f4_39_26);
    expect(crc32Bytes(new Uint8Array())).toBe(0);
  });
});
