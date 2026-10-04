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

  it('runs canonical literal and regex grep over authorized native chunk identities', async () => {
    const grepPath = join(directory, 'grep.sqlite');
    const writer = new DatabaseSync(grepPath);
    writer.exec(`CREATE TABLE index_metadata(singleton INTEGER PRIMARY KEY,schema_version INTEGER,store_id TEXT,index_mode TEXT,profile_json TEXT,profile_hash TEXT);
      INSERT INTO index_metadata VALUES(1,7,'${'a'.repeat(64)}','text-only',NULL,NULL);
      CREATE TABLE file_records(id TEXT PRIMARY KEY,root_id TEXT,path TEXT);
      CREATE TABLE file_chunks(id TEXT,root_id TEXT,file_record_id TEXT,content TEXT,content_hash TEXT,start_line INTEGER,end_line INTEGER,chunk_index INTEGER,chunk_size INTEGER,chunk_type TEXT,start_offset INTEGER,end_offset INTEGER,token_count INTEGER);
      INSERT INTO file_records VALUES('f-a','root-a','a.ts'),('f-b','root-b','b.ts');
      INSERT INTO file_chunks VALUES('chunk-1','root-a','f-a','CAFÉ Alpha','hash-1',1,1,0,10,'text',0,10,3),('chunk-2','root-a','f-a','alphabet','hash-2',2,2,1,8,'text',11,19,1),('chunk-3','root-b','f-b','café alpha','hash-3',1,1,0,10,'text',0,10,3);`);
    writer.close();
    if (!executable) {
      throw new Error('Qualified integration executable is required.');
    }
    const grepClient = await SqliteQueryClient.open({
      databasePath: grepPath,
      deadlineMs: 1000,
      spawn: () => spawnQueryProcess({ environment: { ELECTRON_RUN_AS_NODE: '1' }, executable }),
      startupDeadlineMs: 5000,
    });
    try {
      const literal = await grepClient.grep({
        caseSensitive: false,
        isRegex: false,
        maxRows: 100,
        pattern: 'café',
        rootIds: ['root-a'],
      });
      expect(literal.rows.map((row) => row[0])).toEqual(['chunk-1']);
      expect(literal).toHaveProperty('identity', {
        embedding: { indexMode: 'text-only' },
        storeId: 'a'.repeat(64),
      });
      expect(literal.matchedChunks).toBe(1);
      expect(literal.truncated).toBe(false);
      expect(
        (
          await grepClient.grep({
            caseSensitive: true,
            isRegex: false,
            maxRows: 100,
            pattern: 'café',
            rootIds: ['root-a'],
          })
        ).rows
      ).toEqual([]);
      expect(
        (
          await grepClient.grep({
            caseSensitive: false,
            isRegex: true,
            maxRows: 100,
            pattern: String.raw`\balpha\b`,
            rootIds: ['root-a'],
          })
        ).rows.map((row) => row[0])
      ).toEqual(['chunk-1']);
      const capped = await grepClient.grep({
        caseSensitive: false,
        isRegex: false,
        maxRows: 1,
        pattern: 'alpha',
        rootIds: ['root-a'],
      });
      expect(capped.rows.map((row) => row[0])).toEqual(['chunk-1']);
      expect(capped.matchedChunks).toBe(2);
      expect(capped.truncated).toBe(true);
      const emptyScope = await grepClient.grep({
        caseSensitive: false,
        isRegex: false,
        maxRows: 100,
        pattern: 'alpha',
        rootIds: ['empty-root'],
      });
      expect(emptyScope.rows).toEqual([]);
      expect(emptyScope.matchedChunks).toBe(0);
      expect(emptyScope.identity).toEqual(literal.identity);
      const metadataWriter = new DatabaseSync(grepPath);
      try {
        metadataWriter.exec('UPDATE index_metadata SET schema_version=3');
        await expect(
          grepClient.grep({
            caseSensitive: false,
            isRegex: false,
            maxRows: 100,
            pattern: 'alpha',
            rootIds: ['root-a'],
          })
        ).rejects.toThrow('Derived schema changed');
        metadataWriter.exec('UPDATE index_metadata SET schema_version=7');
      } finally {
        metadataWriter.close();
      }

      await expect(
        grepClient.grep({
          caseSensitive: false,
          isRegex: true,
          maxRows: 100,
          pattern: '(a+)+$',
          rootIds: ['root-a'],
        })
      ).rejects.toThrow('catastrophic backtracking');
      await expect(
        grepClient.grep({
          caseSensitive: false,
          isRegex: false,
          maxRows: 100,
          pattern: 'alpha',
          rootIds: [],
        })
      ).rejects.toThrow();
    } finally {
      await grepClient.close();
    }
  });

  it('counts a valid stored vector identity in empty and matching grep responses', async () => {
    const grepPath = join(directory, 'grep-identity-budget.sqlite');
    const writer = new DatabaseSync(grepPath);
    writer.exec(`CREATE TABLE index_metadata(singleton INTEGER PRIMARY KEY,schema_version INTEGER,store_id TEXT,index_mode TEXT,profile_json TEXT,profile_hash TEXT);
      CREATE TABLE file_records(id TEXT PRIMARY KEY,root_id TEXT,path TEXT);
      CREATE TABLE file_chunks(id TEXT,root_id TEXT,file_record_id TEXT,content TEXT,content_hash TEXT,start_line INTEGER,end_line INTEGER,chunk_index INTEGER,chunk_size INTEGER,chunk_type TEXT,start_offset INTEGER,end_offset INTEGER,token_count INTEGER);
      INSERT INTO file_records VALUES('file','root','a.ts');
      INSERT INTO file_chunks VALUES('chunk','root','file','budget match','hash',1,1,0,12,'text',0,12,2);`);
    const setProfile = (modelId: string): void => {
      const profile = {
        dimensions: 384,
        dtype: 'fp32',
        modelId,
        revision: 'a'.repeat(40),
        tokenCap: 256,
      };
      const profileHash = createHash('sha256')
        .update(
          JSON.stringify([
            profile.modelId,
            profile.revision,
            profile.dtype,
            profile.dimensions,
            profile.tokenCap,
          ])
        )
        .digest('hex');
      writer
        .prepare("INSERT OR REPLACE INTO index_metadata VALUES(1,7,?,'vector-configured',?,?)")
        .run('b'.repeat(64), JSON.stringify(profile), profileHash);
    };
    setProfile('qualified-model');
    if (!executable) {
      throw new Error('Qualified integration executable is required.');
    }
    const grepClient = await SqliteQueryClient.open({
      databasePath: grepPath,
      deadlineMs: 1000,
      spawn: () => spawnQueryProcess({ environment: { ELECTRON_RUN_AS_NODE: '1' }, executable }),
      startupDeadlineMs: 5000,
    });
    const options = {
      caseSensitive: false,
      isRegex: false,
      maxRows: 1,
      pattern: 'budget',
      rootIds: ['root'],
    };
    try {
      expect((await grepClient.grep(options)).rows).toHaveLength(1);
      setProfile('λ'.repeat(600_000));
      await expect(grepClient.grep({ ...options, rootIds: ['empty-root'] })).rejects.toThrow(
        'process-message budget'
      );
      await expect(grepClient.grep(options)).rejects.toThrow('process-message budget');
      setProfile('qualified-model');
      const recovered = await grepClient.grep(options);
      expect(recovered.rows).toHaveLength(1);
      expect(recovered.identity.embedding).toHaveProperty('profile.modelId', 'qualified-model');
    } finally {
      await grepClient.close();
      writer.close();
    }
  });

  it('binds repeated numbered lens parameters without SQL interpolation', async () => {
    const value = "x'; DROP TABLE file_records; --";
    const result = await client.query('SELECT $1 AS first, $1 AS repeated, $2 AS second', {
      bindings: { ['$1']: value, ['$2']: 2 },
    });
    expect(result.rows).toEqual([[value, value, 2]]);
    expect(hash()).toBe(originalHash);
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
