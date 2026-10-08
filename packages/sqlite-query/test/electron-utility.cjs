'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { app, utilityProcess } = require('electron');

const profileDirectory = process.env.SQLITE_QUERY_TEST_USER_DATA_DIR;
if (!profileDirectory) {
  throw new Error('The utility proof requires its runner-owned disposable profile.');
}
app.setPath('userData', profileDirectory);
app.setPath('sessionData', profileDirectory);

const directory = mkdtempSync(join(tmpdir(), 'brainstrike-query-utility-'));
const databasePath = join(directory, 'index.sqlite');
const owned = [];
const processes = [];
const hash = () => createHash('sha256').update(readFileSync(databasePath)).digest('hex');

app
  .whenReady()
  .then(async () => {
    const { SqliteQueryClient, SqliteQueryCancelledError, spawnUtilityQueryProcess } = await import(
      '../dist/index.js'
    );
    const writer = new DatabaseSync(databasePath);
    writer.exec(
      "CREATE TABLE records(id TEXT PRIMARY KEY); INSERT INTO records VALUES('one'); CREATE VIRTUAL TABLE records_fts USING fts5(content); INSERT INTO records_fts VALUES('query index');"
    );
    writer.exec(`CREATE TABLE index_metadata(singleton INTEGER PRIMARY KEY,schema_version INTEGER,store_id TEXT,index_mode TEXT,profile_json TEXT,profile_hash TEXT);
      INSERT INTO index_metadata VALUES(1,10,'${'a'.repeat(64)}','text-only',NULL,NULL);
      CREATE TABLE file_records(id TEXT PRIMARY KEY,root_id TEXT,path TEXT);
      CREATE TABLE file_chunks(id TEXT,root_id TEXT,file_record_id TEXT,content TEXT,content_hash TEXT,start_line INTEGER,end_line INTEGER,chunk_index INTEGER,chunk_size INTEGER,chunk_type TEXT,start_offset INTEGER,end_offset INTEGER,token_count INTEGER);
      INSERT INTO file_records VALUES('file-a','root-a','proof.ts');
      INSERT INTO file_chunks VALUES('one','root-a','file-a','CAFÉ alpha','hash-one',1,1,0,10,'text',0,10,3),('two','root-a','file-a','alphabet','hash-two',2,2,1,8,'text',11,19,1);`);
    writer.close();
    const before = hash();
    const open = async (deadlineMs = 1000) => {
      const client = await SqliteQueryClient.open({
        databasePath,
        deadlineMs,
        spawn: () =>
          spawnUtilityQueryProcess((entryPath) => {
            const host = utilityProcess.fork(entryPath, [], {
              serviceName: 'sqlite-query-proof',
              stdio: 'inherit',
            });
            processes.push(host);
            return host;
          }),
        startupDeadlineMs: 5000,
      });
      owned.push(client);
      return client;
    };
    try {
      const client = await open();
      assert.deepEqual((await client.query('SELECT 1 AS id, 2 AS id')).rows, [[1, 2]]);
      assert.equal(
        (
          await client.query(
            'SELECT bm25(records_fts) FROM records_fts WHERE records_fts MATCH ?',
            { values: ['query'] }
          )
        ).rows.length,
        1
      );
      assert.deepEqual(
        (await client.query('SELECT vec_length(vec_f32(?))', { values: ['[1,2,3]'] })).rows,
        [[3]]
      );
      assert.deepEqual(
        (
          await client.query('SELECT id FROM records WHERE id=?', {
            values: ["x';DROP TABLE records;--"],
          })
        ).rows,
        []
      );
      const grep = await client.grep({
        caseSensitive: false,
        isRegex: false,
        maxRows: 1,
        pattern: 'alpha',
        rootIds: ['root-a'],
      });
      assert.deepEqual(grep.identity, {
        embedding: { indexMode: 'text-only' },
        storeId: 'a'.repeat(64),
      });
      assert.equal(grep.matchedChunks, 2);
      assert.equal(grep.truncated, true);
      assert.deepEqual(
        grep.rows.map((row) => row[0]),
        ['one']
      );
      const unicode = await client.grep({
        caseSensitive: false,
        isRegex: false,
        maxRows: 100,
        pattern: 'café',
        rootIds: ['root-a'],
      });
      assert.deepEqual(
        unicode.rows.map((row) => row[0]),
        ['one']
      );
      assert.equal(hash(), before);
      assert.equal((await client.describeTable('records')).rows[0][0], 'id');
      assert((await client.listTables()).rows.some((row) => row[0] === 'records'));
      for (const sql of [
        "ATTACH ':memory:' AS other",
        `VACUUM INTO '${join(directory, 'stolen.sqlite')}'`,
        'CREATE TEMP TABLE evil(value)',
        'DELETE FROM records',
        'BEGIN',
        'SAVEPOINT s',
        'PRAGMA writable_schema=1',
        'PRAGMA hard_heap_limit=0',
        "SELECT load_extension('missing')",
        "SELECT vec_npy_file('missing')",
        "SELECT fts3_tokenizer('simple')",
        "SELECT sqlite_log(1,'x')",
        'SELECT 1; DROP TABLE records',
        'SELECT length(randomblob(20000000))',
      ]) {
        await assert.rejects(client.query(sql));
        assert.equal(hash(), before);
      }
      const doomed = await open(150);
      let ticks = 0;
      const interval = setInterval(() => {
        ticks += 1;
      }, 10);
      let deadline;
      try {
        await assert.rejects(
          doomed.query(
            'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT count(*) FROM r'
          ),
          (error) => {
            deadline = error;
            return /deadline/.test(error.message);
          }
        );
        await doomed.close();
        assert(ticks > 3);
        await assert.rejects(doomed.query('SELECT 1'), (error) => error === deadline);
      } finally {
        clearInterval(interval);
      }
      const cancelled = await open();
      const cancellationHost = processes.at(-1);
      const cancellationPid = cancellationHost.pid;
      assert(Number.isInteger(cancellationPid));
      let cancellationExited = false;
      cancellationHost.once('exit', () => {
        cancellationExited = true;
      });
      const controller = new AbortController();
      const started = performance.now();
      const timer = setTimeout(() => controller.abort(new Error('User Stop proof')), 50);
      try {
        await assert.rejects(
          cancelled.query(
            'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT count(*) FROM r',
            { signal: controller.signal }
          ),
          (error) =>
            error instanceof SqliteQueryCancelledError &&
            error.phase === 'query' &&
            error.requestId === 2 &&
            error.ownerPid === cancellationPid
        );
      } finally {
        clearTimeout(timer);
      }
      const cancellationMs = performance.now() - started;
      assert(
        cancellationMs < 1000,
        'Cancellation must settle before the unchanged production deadline.'
      );
      assert(cancellationExited, 'Rejection joins actual utility exit.');
      assert.throws(() => process.kill(cancellationPid, 0), { code: 'ESRCH' });
      const metricsContainsExitedPid = app
        .getAppMetrics()
        .some((metric) => metric.pid === cancellationPid);
      await cancelled.close();
      assert.equal(hash(), before);
      const cancellation = {
        cancellationMs,
        cancellationPid,
        code: 'sqlite_query_cancelled',
        joinedExit: cancellationExited,
        metricsContainsExitedPid,
        phase: 'query',
      };
      const afterKillWriter = new DatabaseSync(databasePath);
      afterKillWriter.exec("INSERT INTO records VALUES('after-kill')");
      afterKillWriter.close();
      const fresh = await open();
      assert.deepEqual((await fresh.query("SELECT id FROM records WHERE id='after-kill'")).rows, [
        ['after-kill'],
      ]);
      process.stdout.write(
        `${JSON.stringify({
          cancellation,
          canonicalGrep: true,
          electron: process.versions.electron,
          freshHost: true,
          node: process.versions.node,
          parentTicks: ticks,
          processes: processes.length,
          retainedDeadlineIdentity: true,
          sqlite: process.versions.sqlite,
          unsafeStatementsRefused: 14,
          writerReopen: true,
        })}\n`
      );
    } finally {
      await Promise.all(owned.map((client) => client.close()));
      rmSync(directory, { force: true, recursive: true });
    }
    app.quit();
  })
  .catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    app.exit(1);
  });
