'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { app, utilityProcess } = require('electron');

const profileDirectory = process.env.SQLITE_QUERY_TEST_USER_DATA_DIR;
const indexDirectory = process.env.SQLITE_QUERY_TEST_INDEX_DIR;
if (!(profileDirectory && indexDirectory)) {
  throw new Error('The utility proof requires its runner-owned profile and real index.');
}
app.setPath('userData', profileDirectory);
app.setPath('sessionData', profileDirectory);

// Built by the runner through the real IndexerPort (build-lifecycle-index.mjs).
const databasePath = join(indexDirectory, 'index.sqlite');
const fixture = JSON.parse(readFileSync(join(indexDirectory, 'fixture.json'), 'utf8'));
const owned = [];
const processes = [];
const hash = () => createHash('sha256').update(readFileSync(databasePath)).digest('hex');
const proof = (pattern, overrides = {}) => ({
  caseSensitive: false,
  isRegex: false,
  maxRows: 100,
  pattern,
  rootIds: ['proof-root'],
  ...overrides,
});
// Quadratic backtracking over runaway-root's 300,000-character line: tens of seconds.
// `\w` overlaps `\d`, so V8 cannot make the `+` atomic as it does for `[a-z]+[0-9]`.
const runaway = {
  caseSensitive: true,
  isRegex: true,
  maxRows: 1,
  pattern: String.raw`\w+\d`,
  rootIds: ['runaway-root'],
};

app
  .whenReady()
  .then(async () => {
    const { SqliteQueryClient, SqliteQueryDeadlineError, spawnUtilityQueryProcess } = await import(
      '../dist/index.js'
    );
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
      const [cafe, alphabet] = fixture.chunkIds.proof;
      const client = await open();
      const grep = await client.grep(proof('alpha', { maxRows: 1 }));
      assert.equal(grep.identity.embedding.indexMode, 'text-only');
      assert.match(grep.identity.storeId, /^[0-9a-f]{64}$/u);
      assert.equal(grep.matchedChunks, 2);
      assert.equal(grep.truncated, true);
      assert.ok([cafe, alphabet].includes(grep.rows[0][0]));
      const unicode = await client.grep(proof('café'));
      assert.deepEqual(
        unicode.rows.map((row) => row[0]),
        [cafe]
      );
      assert.equal(hash(), before);

      const doomed = await open(150);
      let ticks = 0;
      const interval = setInterval(() => {
        ticks += 1;
      }, 10);
      let deadline;
      try {
        await assert.rejects(doomed.grep(runaway), (error) => {
          deadline = error;
          return error instanceof SqliteQueryDeadlineError;
        });
        await doomed.close();
        assert(ticks > 3);
        await assert.rejects(doomed.grep(proof('alpha')), (error) => error === deadline);
      } finally {
        clearInterval(interval);
      }

      // Host Stop reaches an in-flight read through its owner's close
      // (closeAllIndexQueries); nothing cancels a single grep.
      const stopped = await open(60_000);
      const stopHost = processes.at(-1);
      const stopPid = stopHost.pid;
      assert(Number.isInteger(stopPid));
      let stopExited = false;
      stopHost.once('exit', () => {
        stopExited = true;
      });
      const inflight = stopped.grep(runaway).catch((error) => error);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const started = performance.now();
      await stopped.close();
      const stopMs = performance.now() - started;
      assert(stopMs < 1000, 'Stop must settle well before the runaway read would.');
      assert(stopExited, 'Close resolves only after the utility exits.');
      assert.throws(() => process.kill(stopPid, 0), { code: 'ESRCH' });
      const stopError = await inflight;
      assert.equal(stopError.message, 'SQLite query client is closed.');
      const metricsContainsExitedPid = app.getAppMetrics().some((metric) => metric.pid === stopPid);
      assert.equal(hash(), before);
      const stop = {
        joinedExit: stopExited,
        metricsContainsExitedPid,
        stopMs,
        stopPid,
      };

      // A killed reader holds no lock: the writer takes its write lock at once.
      const writer = new DatabaseSync(databasePath);
      writer.exec('BEGIN IMMEDIATE; COMMIT');
      writer.close();
      const fresh = await open();
      assert.deepEqual(
        (await fresh.grep(proof('alphabet', { caseSensitive: true }))).rows.map((row) => row[0]),
        [alphabet]
      );
      process.stdout.write(
        `${JSON.stringify({
          canonicalGrep: true,
          electron: process.versions.electron,
          freshHost: true,
          node: process.versions.node,
          parentTicks: ticks,
          processes: processes.length,
          retainedDeadlineIdentity: true,
          sqlite: process.versions.sqlite,
          stop,
          writerLock: true,
        })}\n`
      );
    } finally {
      await Promise.all(owned.map((client) => client.close()));
    }
    app.quit();
  })
  .catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    app.exit(1);
  });
