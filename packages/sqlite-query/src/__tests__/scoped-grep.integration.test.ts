import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { SqliteQueryClient, spawnQueryProcess } from '../../dist/index.js';

const directory = mkdtempSync(join(tmpdir(), 'brainstrike-scoped-grep-'));
const databasePath = join(directory, 'index.sqlite');
let client: SqliteQueryClient;
beforeAll(async () => {
  const writer = new DatabaseSync(databasePath);
  writer.exec(`CREATE TABLE index_metadata(singleton INTEGER, schema_version INTEGER,store_id TEXT,index_mode TEXT,profile_json TEXT,profile_hash TEXT);
    INSERT INTO index_metadata VALUES(1,7,'${'a'.repeat(64)}','text-only',NULL,NULL);
    CREATE TABLE file_records(id TEXT PRIMARY KEY,root_id TEXT,path TEXT,embedding_set_id TEXT,source_path TEXT);
    INSERT INTO file_records VALUES('retained',NULL,NULL,'selected',NULL),('other',NULL,NULL,'unauthorized',NULL);
    CREATE TABLE file_chunks(id TEXT,root_id TEXT,file_record_id TEXT,content TEXT,content_hash TEXT,start_line INTEGER,end_line INTEGER,chunk_index INTEGER,chunk_size INTEGER,chunk_type TEXT,start_offset INTEGER,end_offset INTEGER,token_count INTEGER);
    INSERT INTO file_chunks VALUES('${'b'.repeat(64)}',NULL,'retained','actual retained marker','${'c'.repeat(64)}',1,1,0,384,'text',0,22,4),('${'d'.repeat(64)}',NULL,'other','actual retained marker','${'e'.repeat(64)}',1,1,0,384,'text',0,22,4);`);
  writer.close();
  const executable = process.env['SQLITE_QUERY_TEST_EXEC_PATH'];
  if (!executable) {
    throw new Error('A qualified Electron executable is required.');
  }
  client = await SqliteQueryClient.open({
    databasePath,
    deadlineMs: 1000,
    spawn: () =>
      spawnQueryProcess({
        environment: { ELECTRON_RUN_AS_NODE: '1' },
        executable,
      }),
    startupDeadlineMs: 5000,
  });
});
afterAll(async () => {
  await client?.close();
  rmSync(directory, { force: true, recursive: true });
});

it('reads only the retained canonical collection bindings in the public killable reader', async () => {
  const result = await client.grep({
    caseSensitive: true,
    fileIds: ['retained'],
    isRegex: false,
    maxRows: 100,
    pattern: 'marker',
    rootIds: [],
  });
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]?.[1]).toBeNull();
  expect(result.rows[0]?.[2]).toBe('retained');
  expect(result.rows[0]?.[3]).toBeNull();
  expect(result.rows[0]?.[14]).toBe('selected');
  expect(result.matchedChunks).toBe(1);
  expect(result.truncated).toBe(false);
  expect((await client.query('SELECT count(*) FROM file_records')).rows).toEqual([[2]]);
});

it('keeps an empty authorized collection empty and never broadens to all files', async () => {
  const result = await client.grep({
    caseSensitive: false,
    fileIds: [],
    isRegex: false,
    maxRows: 100,
    pattern: 'marker',
    rootIds: [],
  });
  expect(result.rows).toEqual([]);
  expect(result.matchedChunks).toBe(0);
});

it('reads the full authorized inventory beyond the SQLite variable limit', async () => {
  const largePath = join(directory, 'large-scope.sqlite');
  copyFileSync(databasePath, largePath);
  const fileIds = Array.from({ length: 32_767 }, (_, index) => `authorized-${index}`);
  const writer = new DatabaseSync(largePath);
  try {
    writer.exec('BEGIN');
    const insert = writer.prepare('INSERT INTO file_records VALUES(?,NULL,NULL,?,NULL)');
    for (const fileId of fileIds) {
      insert.run(fileId, 'selected');
    }
    writer.exec(`INSERT INTO file_records VALUES('workspace','root-a','root.ts','selected',NULL);
      INSERT INTO file_chunks VALUES('${'f'.repeat(64)}','root-a','workspace','workspace marker','${'1'.repeat(64)}',1,1,0,384,'text',0,16,2);`);
    writer.exec('COMMIT');
  } finally {
    writer.close();
  }
  // Put the real retained binding last so truncating the inventory loses its match.
  fileIds.push('retained');
  const options = {
    caseSensitive: true,
    fileIds,
    isRegex: false,
    maxRows: 100,
    pattern: 'marker',
    rootIds: [],
  };
  const executable = process.env['SQLITE_QUERY_TEST_EXEC_PATH'];
  if (!executable) {
    throw new Error('A qualified reader executable is required.');
  }
  const largeClient = await SqliteQueryClient.open({
    databasePath: largePath,
    deadlineMs: 1000,
    spawn: () => spawnQueryProcess({ environment: { ELECTRON_RUN_AS_NODE: '1' }, executable }),
    startupDeadlineMs: 5000,
  });
  try {
    const result = await largeClient.grep(options);
    expect(result.rows.map((row) => row[2])).toEqual(['retained']);
    expect(result.rows[0]?.[1]).toBeNull();
    expect(result.rows[0]?.[3]).toBeNull();
    expect(result.rows[0]?.[14]).toBe('selected');
    expect(result.matchedChunks).toBe(1);
    expect(result.truncated).toBe(false);
    const nonmatching = await largeClient.grep({ ...options, pattern: 'not in either chunk' });
    expect(nonmatching.rows).toEqual([]);
    expect(nonmatching.matchedChunks).toBe(0);
    const empty = await largeClient.grep({ ...options, fileIds: [] });
    expect(empty.rows).toEqual([]);
    expect(empty.matchedChunks).toBe(0);
    const legacy = await largeClient.grep({
      caseSensitive: true,
      isRegex: false,
      maxRows: 100,
      pattern: 'marker',
      rootIds: ['root-a'],
    });
    expect(legacy.rows.map((row) => row[2])).toEqual(['workspace']);
    expect(legacy.rows[0]?.[1]).toBe('root-a');
    expect(legacy.rows[0]?.[3]).toBe('root.ts');
  } finally {
    await largeClient.close();
  }
});
