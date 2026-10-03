import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteQueryClient, spawnQueryProcess } from '../../dist/index.js';

const directory = mkdtempSync(join(tmpdir(), 'brainstrike-sqlite-query-'));
const databasePath = join(directory, 'index.sqlite');
const executable = process.env['SQLITE_QUERY_TEST_EXEC_PATH'];
const clients: SqliteQueryClient[] = [];
const hash = (): string => createHash('sha256').update(readFileSync(databasePath)).digest('hex');
let originalHash: string;
let client: SqliteQueryClient;

async function open(deadlineMs = 1000): Promise<SqliteQueryClient> {
  if (!executable) {
    throw new Error('SQLITE_QUERY_TEST_EXEC_PATH must identify a qualified Electron executable.');
  }
  const result = await SqliteQueryClient.open({
    databasePath,
    deadlineMs,
    spawn: () => spawnQueryProcess({ environment: { ELECTRON_RUN_AS_NODE: '1' }, executable }),
    startupDeadlineMs: 5000,
  });
  clients.push(result);
  return result;
}

beforeAll(async () => {
  const writer = new DatabaseSync(databasePath);
  writer.exec(`CREATE TABLE file_records(id TEXT PRIMARY KEY, content TEXT);
    INSERT INTO file_records VALUES('one','index search chunk');
    CREATE VIRTUAL TABLE file_chunks_fts USING fts5(content);
    INSERT INTO file_chunks_fts VALUES('index search chunk');`);
  writer.close();
  originalHash = hash();
  client = await open();
});

afterAll(async () => {
  await Promise.all(clients.map((owned) => owned.close()));
  rmSync(directory, { force: true, recursive: true });
});

describe('qualified engine refuses unsafe SQL and retains index bytes', () => {
  it.each([
    "ATTACH ':memory:' AS other",
    `VACUUM INTO '${join(directory, 'stolen.sqlite')}'`,
    'VACUUM',
    "SELECT load_extension('missing')",
    "SELECT vec_npy_file('missing')",
    "SELECT fts3_tokenizer('simple')",
    "SELECT sqlite_log(1, 'x')",
    'CREATE TEMP TABLE evil(value)',
    'CREATE TABLE evil(value)',
    "INSERT INTO file_records VALUES('two','changed')",
    "UPDATE file_records SET content='changed'",
    'DELETE FROM file_records',
    'DROP TABLE file_records',
    'BEGIN',
    'SAVEPOINT s',
    'ANALYZE',
    'PRAGMA writable_schema=1',
    'PRAGMA hard_heap_limit=0',
    'PRAGMA query_only',
    'PRAGMA wal_checkpoint(TRUNCATE)',
    'SELECT 1; DROP TABLE file_records',
    'SELECT length(randomblob(20000000))',
  ])('refuses %s', async (sql) => {
    await expect(client.query(sql)).rejects.toThrow();
    expect(hash()).toBe(originalHash);
    expect(existsSync(join(directory, 'stolen.sqlite'))).toBe(false);
  });

  it('runs FTS5, vector functions, recursive reads and bound values', async () => {
    expect(
      (
        await client.query(
          'SELECT bm25(file_chunks_fts) FROM file_chunks_fts WHERE file_chunks_fts MATCH ?',
          { values: ['index'] }
        )
      ).rows
    ).toHaveLength(1);
    expect(
      (await client.query('SELECT vec_length(vec_f32(?))', { values: ['[1,2,3]'] })).rows
    ).toEqual([[3]]);
    expect(
      (
        await client.query('SELECT content FROM file_records WHERE id=?', {
          values: ["x'; DROP TABLE file_records; --"],
        })
      ).rows
    ).toEqual([]);
    const result = await client.query(
      'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<500) SELECT n FROM r',
      { maxRows: 7 }
    );
    expect(result.rows).toHaveLength(7);
    expect(result.truncated).toBe(true);
  });

  it('preserves duplicate columns and introspects a bound table', async () => {
    const result = await client.query('SELECT 1 AS id, 2 AS id;');
    expect(result.columns).toEqual(['id', 'id']);
    expect(result.rows).toEqual([[1, 2]]);
    expect((await client.describeTable('file_records')).rows.map((row) => row[0])).toEqual([
      'id',
      'content',
    ]);
    expect((await client.listTables()).rows.some((row) => row[0] === 'file_records')).toBe(true);
  });

  it('refuses oversized IPC results before returning them to the parent', async () => {
    await expect(
      client.query(
        'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<20) SELECT hex(zeroblob(40000)) FROM r'
      )
    ).rejects.toThrow('process-message budget');
    expect((await client.query('SELECT length(zeroblob(40000))')).rows).toEqual([[40_000]]);
  });

  it('kills a runaway process, preserves its deadline error, releases the writer and permits an explicit fresh host', async () => {
    const doomed = await open(150);
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
    }, 10);
    try {
      await expect(
        doomed.query(
          'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT count(*) FROM r'
        )
      ).rejects.toThrow('deadline');
      await doomed.close();
      expect(ticks).toBeGreaterThan(3);
      await expect(doomed.query('SELECT 1')).rejects.toThrow('deadline');
      const writer = new DatabaseSync(databasePath);
      writer.exec("INSERT INTO file_records VALUES('after-kill','writer remains usable')");
      writer.close();
      const fresh = await open();
      expect(
        (await fresh.query("SELECT content FROM file_records WHERE id='after-kill'")).rows
      ).toEqual([['writer remains usable']]);
    } finally {
      clearInterval(interval);
    }
  });
});
