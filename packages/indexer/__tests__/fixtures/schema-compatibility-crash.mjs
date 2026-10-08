import { readFileSync, writeFileSync } from 'node:fs';
import { isMainThread, Worker, workerData } from 'node:worker_threads';
import { openConnection } from '@brainstrike/sqlite-native';
import { loadStateProjection } from '../../dist/state-projection.js';
import { IndexWriter } from '../../dist/store.js';

// A separate real process lets SIGKILL interrupt the actual sole writer's native transaction.
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { optionsPath: process.argv[2], receiptPath: process.argv[3] },
  });
  worker.once('error', (error) => {
    throw error;
  });
} else {
  const options = JSON.parse(readFileSync(workerData.optionsPath, 'utf8'));
  const projection = await loadStateProjection(options.stateProjection, options.stateRoot);
  const probe = openConnection(options.dbPath);
  const prototype = Object.getPrototypeOf(probe);
  const prepare = prototype.prepare;
  probe.close();
  /** @this {import('better-sqlite3').Database} @param {string} sql */
  prototype.prepare = function intercept(sql) {
    if (sql === 'UPDATE index_metadata SET schema_version=? WHERE singleton=1') {
      const version = prepare.call(this, 'SELECT schema_version FROM index_metadata').pluck().get();
      const added = prepare
        .call(this, "SELECT count(*) FROM sqlite_schema WHERE name='state_observation_vectors'")
        .pluck()
        .get();
      writeFileSync(
        workerData.receiptPath,
        JSON.stringify({ added, inTransaction: this.inTransaction, version })
      );
      process.kill(process.pid, 'SIGKILL');
    }
    return prepare.call(this, sql);
  };
  const writer = new IndexWriter(options, projection);
  writer.close();
  throw new Error('Crash frontier was not reached');
}
