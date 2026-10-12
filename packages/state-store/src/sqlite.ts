// Read-only connections and the consistent export copy (M0-A2 src/sqlite.ts).
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/** A read-only connection. It never writes the truth (M0-A2 item 7: the indexer opens it read-only). */
export function openRo(path: string): Db {
  const db = new Database(path, { fileMustExist: true, readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

const BS_PATH = createRequire(import.meta.url).resolve('better-sqlite3');
const VACUUM_SRC = `
const { workerData, parentPort } = require('node:worker_threads');
const Database = require(${JSON.stringify(BS_PATH)});
try {
  const db = new Database(workerData.src, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  db.prepare('VACUUM INTO ?').run(workerData.dest);
  db.close();
  parentPort.postMessage({ ok: true });
} catch (e) { parentPort.postMessage({ ok: false, error: String(e && e.stack || e) }); }
`;

/**
 * Transactionally consistent copy of `src` into `dest`, on a worker thread with its own read-only connection, so the
 * copy neither blocks the event loop nor takes the writer's connection.
 */
export function vacuumInto(src: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const w = new Worker(VACUUM_SRC, { eval: true, workerData: { dest, src } });
    let settled = false;
    w.once('message', (m: { ok: boolean; error?: string }) => {
      settled = true;
      if (m.ok) {
        resolve();
      } else {
        reject(new Error(m.error));
      }
    });
    w.once('error', (e) => {
      settled = true;
      reject(e);
    });
    w.once('exit', (code) => {
      if (!settled) {
        reject(new Error(`VACUUM INTO worker exited ${code} without a result`));
      }
    });
  });
}
