// @ts-check
// The writer: the ONLY connection that writes the state DB, on its own worker thread (M0-A1 src/store-sqlite-worker.mjs).
// The main thread only posts messages, so no SQLite call and no sync ever runs on its event loop (ADR-0011). Messages are
// handled strictly in arrival order, so appends and boundary syncs are serialized exactly as the main thread posted them.
// Blob files are written here too: a blob write ends in an fsync, and a write(2) or sync on the event loop is what M0-A1
// measured stalling tool reads (4.32x idle on APFS) until the writes moved to a writer worker.
//
// PRAGMAs (sqlite.org/pragma.html), verified at runtime by the S-pragmas test:
//   journal_mode=WAL; synchronous=NORMAL  "no sync operations occur during most transactions" (pragma synchronous)
//   fullfsync=ON (macOS)                  "the F_FULLFSYNC syncing method is used" (implies checkpoint_fullfsync)
//   secure_delete=ON                      deleted and overwritten row bytes are zeroed, not left in free pages
//   wal_autocheckpoint=0                  SQLite's default checkpoints "whenever a COMMIT occurs that causes the WAL file
//                                         to be 1000 pages or more" (wal.html 3.1), i.e. a WAL sync + DB sync INSIDE a
//                                         streaming commit; the boundary op checkpoints instead (src/run-log.mjs boundary)
// `walCheckpoint: 'sqlite-auto'` keeps SQLite's default and exists ONLY as the kernel-sync probe's negative control.
//
// Open (M0-A2 src/host.ts): `integrity_check` (not `quick_check`, which misses index corruption, M0-A2 item 3c). A
// damaged DB opens read-only (`query_only`) and says so; nothing is migrated or written.
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { newRetryStats, retrySharing } from './fs-retry.mjs';
import { exportJsonl, readJsonl } from './jsonl.mjs';
import { executeMcpTaskRequest } from './mcp-task-domain.mjs';
import { executeMemoryRequest, executeNativeMemoryRequest } from './memory-domain.mjs';
import { isCorrupt, RunLog, ThreadDamage, ThreadReadOnlyRefusal } from './run-log.mjs';
import { blobsOf } from './run-log-format.mjs';
import { migrate } from './schema.mjs';
import { CheckpointBlockedError } from './sqlite-checkpoint.mjs';

/**
 * @typedef {object} WriterConfig
 * @property {string} path
 * @property {string} blobsDir
 * @property {boolean} fullfsync
 * @property {'boundary' | 'sqlite-auto'} walCheckpoint
 * @property {number} checkpointPages
 * @property {number} busyTimeoutMs
 * @property {{ purgeInTxn?: 'sigkill' } | undefined} crashTestHooks
 * @property {string | undefined} memoryCalculatorModule
 */

const port = parentPort;
if (!port) {
  throw new Error('writer-worker must run on a worker thread');
}
const cfg = /** @type {WriterConfig} */ (workerData);
/** uv_hrtime clock, the same in every thread and in native tracers (M0-A1 src/store.ts clockNow) */
const clock = () => Number(process.hrtime.bigint()) / 1e6;

/** @type {Database.Database | null} */
let opened = null;
/** @type {string | null} */
let damage = null;
try {
  opened = new Database(cfg.path);
  opened.pragma('journal_mode = WAL');
  opened.pragma('synchronous = NORMAL');
  if (cfg.fullfsync) {
    opened.pragma('fullfsync = ON');
  }
  opened.pragma('secure_delete = ON');
  opened.pragma('foreign_keys = ON');
  opened.pragma(`wal_autocheckpoint = ${cfg.walCheckpoint === 'sqlite-auto' ? 1000 : 0}`);
  opened.pragma(`busy_timeout = ${cfg.busyTimeoutMs}`);
  const rows = /** @type {Array<{ integrity_check: string }>} */ (opened.pragma('integrity_check'));
  if (!(rows.length === 1 && rows[0]?.integrity_check === 'ok')) {
    damage = rows.map((r) => r.integrity_check).join('; ');
  }
} catch (e) {
  if (!isCorrupt(e)) {
    throw e;
  }
  opened?.close();
  opened = new Database(cfg.path, { fileMustExist: true, readonly: true });
  opened.pragma(`busy_timeout = ${cfg.busyTimeoutMs}`);
  damage = String(/** @type {Error} */ (e).message);
}
const db = opened;
if (damage) {
  db.pragma('query_only = ON');
} else {
  migrate(db);
}
let log = new RunLog(db, damage);
const blobRetry = newRetryStats();

const settings = {
  fullfsync: db.pragma('fullfsync', { simple: true }),
  journalMode: db.pragma('journal_mode', { simple: true }),
  secureDelete: db.pragma('secure_delete', { simple: true }),
  sqliteVersion: db.prepare('select sqlite_version()').pluck().get(),
  synchronous: db.pragma('synchronous', { simple: true }),
  walAutocheckpoint: db.pragma('wal_autocheckpoint', { simple: true }),
};

/**
 * fsync of a directory after an entry in it was created, renamed or removed. Skipped on Windows, which cannot open a
 * directory for fsync (M0-A1 src/store-jsonl.ts:226).
 * @param {string} dir
 */
function fsyncDir(dir) {
  if (process.platform === 'win32') {
    return;
  }
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Content-addressed blob write (M0-A2 src/host.ts putBlob): temp + fsync + rename + directory fsync, so the blob is
 * durable before the event that references it is appended. An existing blob is left as it is.
 * @param {string} hash
 * @param {string} content
 */
function putBlob(hash, content) {
  if (!/^[a-f0-9]{64}$/.test(hash) || createHash('sha256').update(content).digest('hex') !== hash) {
    throw new Error('blob hash does not match its content');
  }
  const p = join(cfg.blobsDir, hash);
  if (existsSync(p)) {
    if (createHash('sha256').update(readFileSync(p)).digest('hex') !== hash) {
      throw new Error(`existing blob ${hash} checksum mismatch`);
    }
    return;
  }
  const tmp = `${p}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    let off = 0;
    const buf = Buffer.from(content, 'utf8');
    while (off < buf.length) {
      off += writeSync(fd, buf, off, buf.length - off);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const err = retrySharing(() => renameSync(tmp, p), blobRetry);
  if (err) {
    throw err;
  }
  fsyncDir(cfg.blobsDir);
}

/**
 * Unlink blobs the purge orchestration found unreferenced. Returns the hashes actually removed.
 * @param {string[]} hashes
 * @returns {string[]}
 */
function unlinkBlobs(hashes) {
  /** @type {string[]} */
  const deleted = [];
  for (const h of hashes) {
    const p = join(cfg.blobsDir, h);
    if (!existsSync(p)) {
      continue;
    }
    const err = retrySharing(() => unlinkSync(p), blobRetry);
    if (err) {
      throw err;
    }
    deleted.push(h);
  }
  if (deleted.length > 0) {
    fsyncDir(cfg.blobsDir);
  }
  return deleted;
}

/** @param {unknown} e */
function errorReply(e) {
  if (e instanceof ThreadReadOnlyRefusal) {
    return { error: e.message, errorKind: 'readonly', threadId: e.threadId };
  }
  if (e instanceof ThreadDamage) {
    return {
      atSeq: e.atSeq,
      detail: e.detail,
      error: e.message,
      errorKind: 'damaged',
      threadId: e.threadId,
    };
  }
  if (e instanceof CheckpointBlockedError) {
    return { error: e.message, errorKind: 'checkpoint-blocked' };
  }
  const err = /** @type {Error} */ (e);
  return { error: String(err?.stack ?? err), errorKind: 'failed' };
}

/** @param {import('./run-log.mjs').AppendRow[]} rows */
function verifyBlobReferences(rows) {
  for (const row of rows) {
    for (const hash of blobsOf(row[3])) {
      const path = join(cfg.blobsDir, hash);
      if (!existsSync(path)) {
        throw new Error(`event references missing blob ${hash}`);
      }
      if (createHash('sha256').update(readFileSync(path)).digest('hex') !== hash) {
        throw new Error(`referenced blob ${hash} checksum mismatch`);
      }
    }
  }
}

/** Resource identities are retained in the existing purge intent before FK deletion.
 * @param {string} threadId @param {number} seq
 * @param {'clear' | 'detach-thread'} sharedResource
 * @param {import('./memory-types.js').ObservationTokenCounter} [countTokens] */
function eraseThreadMemory(threadId, seq, sharedResource, countTokens) {
  const intent = /** @type {{ memory_resources:string } | undefined} */ (
    db
      .prepare('SELECT memory_resources FROM purge_intent WHERE thread_id=? AND seq=?')
      .get(threadId, seq)
  );
  if (!intent) {
    throw new Error('Memory erasure requires the existing purge intent');
  }
  for (const resourceId of JSON.parse(intent.memory_resources)) {
    executeMemoryRequest(
      db,
      { operation: 'purge-thread', resourceId, sharedResource, threadId },
      countTokens
    );
  }
}

/**
 * Mastra OM's observation token counter, from the configured native memory
 * calculator module; none when no calculator is configured.
 * @returns {Promise<import('./memory-types.js').ObservationTokenCounter | undefined>} */
async function observationTokenCounter() {
  if (!cfg.memoryCalculatorModule) {
    return;
  }
  const module = await import(pathToFileURL(cfg.memoryCalculatorModule).href);
  if (typeof module.countObservationTokens !== 'function') {
    throw new Error('Configured observation token counter is unavailable');
  }
  return /** @type {import('./memory-types.js').ObservationTokenCounter} */ (
    module.countObservationTokens
  );
}

/** @param {import('./memory-types.js').MemoryDomainRequest} request */
async function handleMemory(request) {
  if (request.operation !== 'native') {
    const countTokens =
      request.operation === 'purge-thread' ? await observationTokenCounter() : undefined;
    return { snapshot: executeMemoryRequest(db, request, countTokens) };
  }
  if (!cfg.memoryCalculatorModule) {
    throw new Error('Native memory calculator capability is unavailable');
  }
  const module = await import(pathToFileURL(cfg.memoryCalculatorModule).href);
  if (typeof module.calculateMemoryMutation !== 'function') {
    throw new Error('Configured native memory calculator is unavailable');
  }
  const calculate = /** @type {import('./memory-types.js').MemoryNativeCalculator} */ (
    module.calculateMemoryMutation
  );
  return { snapshot: await executeNativeMemoryRequest(db, request, calculate) };
}

/** Read one verified snapshot on this existing serialized writer. */
function readAll() {
  const rows = [];
  for (const threadId of log.threads()) {
    const result = log.readFrom(threadId, 1, Number.MAX_SAFE_INTEGER);
    if (result.damage) {
      throw result.damage;
    }
    rows.push(...result.rows.map((row) => ({ ...row, threadId })));
  }
  return { rows };
}

/** @param {{ op: string; id: number; [k: string]: unknown }} m */
async function handle(m) {
  switch (m.op) {
    case 'memory':
      return handleMemory(
        /** @type {import('./memory-types.js').MemoryDomainRequest} */ (m['request'])
      );
    case 'mcp-tasks':
      return executeMcpTaskRequest(
        db,
        /** @type {import('./mcp-task-types.js').McpTaskDomainRequest} */ (m['request'])
      );
    case 'append': {
      const t0 = clock();
      const rows = /** @type {import('./run-log.mjs').AppendRow[]} */ (m['rows']);
      verifyBlobReferences(rows);
      const boundary = m['boundary'] === true;
      if (boundary) {
        db.pragma('synchronous = FULL');
      }
      let seqs;
      const ts = Date.now();
      try {
        seqs = log.append(rows, ts, boundary);
      } finally {
        if (boundary) {
          db.pragma('synchronous = NORMAL');
        }
      }
      return { seqs, t0, t1: clock(), ts };
    }
    case 'boundary': {
      const t0 = clock();
      const checkpoint = log.boundary(
        String(m['threadId']),
        cfg.walCheckpoint,
        cfg.checkpointPages
      );
      return { checkpoint, t0, t1: clock() };
    }
    case 'read': {
      const keep = /** @type {readonly string[] | undefined} */ (m['keepChunkTypes']);
      const r = keep
        ? log.readHydration(String(m['threadId']), Number(m['fromSeq']), keep)
        : log.readFrom(String(m['threadId']), Number(m['fromSeq']), Number(m['limit']));
      return { damage: r.damage ? errorReply(r.damage) : null, rows: r.rows };
    }
    case 'threadTimes':
      return { threads: log.threadTimes() };
    case 'storedBlobRefs':
      return { hashes: log.storedBlobRefs(String(m['threadId'])) };
    case 'damagedBlobRefs':
      return { hashes: log.damagedBlobRefs() };
    case 'readAll':
      return readAll();
    case 'status':
      return { status: log.status(String(m['threadId'])) };
    case 'threads':
      return { threads: log.threads() };
    case 'okThreads':
      return { threads: log.threads().filter((t) => log.status(t).kind === 'ok') };
    case 'check':
      return log.check();
    case 'purge': {
      // The signal reaches the process asynchronously to this thread: the throw keeps the transaction from committing
      // in the meantime (M0-A2 host-proc `die`).
      const kill =
        cfg.crashTestHooks?.purgeInTxn === 'sigkill'
          ? () => {
              process.kill(process.pid, 'SIGKILL');
              throw new Error('unreachable: SIGKILL was sent');
            }
          : undefined;
      const threadId = String(m['threadId']);
      const seq = Number(m['seq']);
      log.purge(threadId, seq, String(m['tombstone']), () => {
        // A purge erases what the thread may have contributed to shared memory.
        eraseThreadMemory(threadId, seq, 'clear');
        kill?.();
      });
      return {};
    }
    case 'deleteThread': {
      const threadId = String(m['threadId']);
      // Loaded before the transaction; the StateStore write chain keeps this op in order.
      const countTokens = await observationTokenCounter();
      // Deleting a thread keeps shared resource memory, as legacy did, minus its own sections.
      log.deleteThread(threadId, () =>
        eraseThreadMemory(threadId, 0, 'detach-thread', countTokens)
      );
      return {};
    }
    case 'intentRecord': {
      // A retry after a failed purge finds the event already tombstoned: keep the blob hashes the first attempt recorded.
      db.prepare(
        'INSERT INTO purge_intent (thread_id, seq, hashes, operation, memory_resources) VALUES (?, ?, ?, ?, ?) ON CONFLICT(thread_id, seq) DO NOTHING'
      ).run(
        m['threadId'],
        m['seq'],
        m['hashes'],
        m['operation'] === 'thread' ? 'thread' : 'event',
        JSON.stringify(
          db
            .prepare(
              'SELECT DISTINCT resource_id FROM brainstrike_memory_entities WHERE thread_id=?'
            )
            .pluck()
            .all(m['threadId'])
        )
      );
      const row = /** @type {{ hashes: string }} */ (
        db
          .prepare('SELECT hashes FROM purge_intent WHERE thread_id = ? AND seq = ?')
          .get(m['threadId'], m['seq'])
      );
      return { hashes: row.hashes };
    }
    case 'intentList':
      return {
        intents: db
          .prepare(
            'SELECT thread_id AS threadId, seq, hashes, operation FROM purge_intent ORDER BY rowid'
          )
          .all(),
      };
    case 'intentDelete':
      db.prepare('DELETE FROM purge_intent WHERE thread_id = ? AND seq = ?').run(
        m['threadId'],
        m['seq']
      );
      return {};
    case 'exportJsonl':
      exportJsonl(db, cfg.blobsDir, String(m['path']));
      return {};
    case 'importJsonl': {
      if (db.prepare('SELECT count(*) FROM run_events').pluck().get() !== 0) {
        throw new Error('JSONL import requires an empty run log');
      }
      const data = readJsonl(String(m['path']));
      for (const blob of data.blobs) {
        putBlob(blob.hash, blob.content);
      }
      db.transaction(() => {
        for (const row of data.rows) {
          const event = JSON.parse(row.payload);
          db.prepare(
            'INSERT INTO run_events(thread_id,seq,type,run_id,payload,crc,raw_count,created_at) VALUES (?,?,?,?,?,?,?,?)'
          ).run(
            row.threadId,
            row.seq,
            event.type,
            typeof event.runId === 'string' ? event.runId : null,
            row.payload,
            row.crc,
            row.rawCount,
            row.createdAt
          );
          db.prepare(
            'INSERT INTO threads(id,last_seq,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seq=excluded.last_seq,updated_at=excluded.updated_at'
          ).run(row.threadId, row.seq, row.createdAt, row.createdAt);
        }
      })();
      log = new RunLog(db, damage);
      return {};
    }
    case 'setting':
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run(m['key'], m['value']);
      return {};
    case 'getSetting':
      return {
        value: db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get(m['key']) ?? null,
      };
    case 'deleteSetting':
      return {
        deleted: db.prepare('DELETE FROM settings WHERE key = ?').run(m['key']).changes > 0,
      };
    case 'putBlob':
      putBlob(String(m['hash']), String(m['content']));
      return {};
    case 'unlinkBlobs':
      return { deleted: unlinkBlobs(/** @type {string[]} */ (m['hashes'])) };
    case 'close':
      db.close();
      return {};
    default:
      throw new Error(`unknown op ${m.op}`);
  }
}

port.on('message', (/** @type {{ op: string; id: number }} */ m) => {
  handle(m).then(
    (result) => port.postMessage({ id: m.id, ...result }),
    (cause) => port.postMessage({ id: m.id, ...errorReply(cause) })
  );
});
port.postMessage({ damage, ready: true, settings });
