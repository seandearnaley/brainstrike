import { mkdtempSync, rmSync } from 'node:fs';
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
    INSERT INTO index_metadata VALUES(1,5,'${'a'.repeat(64)}','text-only',NULL,NULL);
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
