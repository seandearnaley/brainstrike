'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { app, utilityProcess } = require('electron');

const directory = mkdtempSync(join(tmpdir(), 'brainstrike-query-utility-'));
const databasePath = join(directory, 'index.sqlite');
const owned = [];
const processes = [];
const hash = () => createHash('sha256').update(readFileSync(databasePath)).digest('hex');

app
  .whenReady()
  .then(async () => {
    const { SqliteQueryClient, spawnUtilityQueryProcess } = await import('../dist/index.js');
    const writer = new DatabaseSync(databasePath);
    writer.exec(
      "CREATE TABLE records(id TEXT PRIMARY KEY); INSERT INTO records VALUES('one'); CREATE VIRTUAL TABLE records_fts USING fts5(content); INSERT INTO records_fts VALUES('query index');"
    );
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
      const afterKillWriter = new DatabaseSync(databasePath);
      afterKillWriter.exec("INSERT INTO records VALUES('after-kill')");
      afterKillWriter.close();
      const fresh = await open();
      assert.deepEqual((await fresh.query("SELECT id FROM records WHERE id='after-kill'")).rows, [
        ['after-kill'],
      ]);
      process.stdout.write(
        `${JSON.stringify({
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
