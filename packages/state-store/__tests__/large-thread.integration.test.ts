// M0-A2 items 1, 3d and 5 at the spike's full size (M0_THREAD_MB=100 in the final spike run): purge and export of a
// 100 MB thread while it streams, and the cost of verifying a 100 MB thread at open. STATE_STORE_THREAD_MB overrides
// the size. The 8 MB runs of the first two are in the unit lane (i1-purge, i5-export).
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, expect, test } from 'vitest';
import { RunLog } from '../src/run-log.mjs';
import { migrate } from '../src/schema.mjs';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { prose, rng } from './helpers/testkit.js';
import { exportWhileStreaming } from './suites/export-while-streaming.js';
import { purgeWhileStreaming } from './suites/purge-while-streaming.js';

const MB = Number(process.env['STATE_STORE_THREAD_MB'] ?? '100');
afterAll(() => cleanupDirs());

test(`purge k from a ${MB} MB thread while it streams`, async () => {
  const res = await purgeWhileStreaming(MB);
  process.stdout.write(`[i1 ${MB}MB] ${JSON.stringify(res)}\n`);
}, 900_000);

test(`export of a ${MB} MB thread while it streams is a consistent snapshot; import round-trips byte-identically`, async () => {
  const res = await exportWhileStreaming(MB);
  process.stdout.write(`[i5 ${MB}MB] ${JSON.stringify(res)}\n`);
}, 900_000);

const time = <T>(fn: () => T): { ms: number; v: T } => {
  const t0 = performance.now();
  const v = fn();
  return { ms: performance.now() - t0, v };
};
const med = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

test(`open-time verification of a ${MB} MB thread: per-row crc, quick_check, integrity_check (measurement)`, () => {
  const r = rng(91);
  const bodies: string[] = [];
  let bytes = 0;
  while (bytes < MB * 1024 * 1024) {
    const b = JSON.stringify({ content: prose(r, 2000), type: 'text', v: 2 });
    bodies.push(b);
    bytes += b.length + 20;
  }
  const path = join(freshDir('i3cost'), 'state.db');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  const log = new RunLog(db, null);
  for (let i = 0; i < bodies.length; i += 1000) {
    log.append(
      bodies.slice(i, i + 1000).map((b) => ['t1', 'text', null, b, null, 1]),
      Date.now()
    );
  }
  db.pragma('wal_checkpoint(TRUNCATE)');
  const crc: number[] = [];
  const quick: number[] = [];
  const integ: number[] = [];
  for (let rep = 0; rep < 3; rep++) {
    const s = time(() => new RunLog(db, null).status('t1'));
    expect(s.v).toEqual({ kind: 'ok', tail: bodies.length });
    crc.push(s.ms);
    quick.push(time(() => db.pragma('quick_check')).ms);
    integ.push(time(() => db.pragma('integrity_check')).ms);
  }
  db.close();
  process.stdout.write(
    `[i3 open cost ${MB}MB] ${JSON.stringify({ allMs: { crc, integ, quick }, events: bodies.length, medianMs: { integrityCheck: med(integ), quickCheck: med(quick), threadCrcScan: med(crc) } })}\n`
  );
}, 900_000);
