/// <reference lib="webworker" />
// BST-1940 spike: the web state-DB worker. Takes the origin Web Lock, and only then installs the
// opfs-sahpool VFS and opens state.db + state-index.sqlite with EXCLUSIVE locking and WAL.
// Applies the desktop schema unchanged (desktop-ddl.mjs) and runs the shared workload.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { SCHEMA_VERSION, UPGRADES } from '../../state-store/src/schema.mjs';
import recorded from '../../test-utils/fixtures/recorded-grep-patterns.json';
import { createGrepLineMatcher } from '../../utils/dist/grep-line-matcher.js';
import { planGrepTrigramCandidates } from '../../utils/dist/grep-trigram-plan.js';
import { crc32 } from './crc32';
import {
  applyFtsConfig,
  diffSchema,
  migrateState,
  readSchema,
  replayObjects,
} from './desktop-ddl.mjs';
import schema from './desktop-schema.json';
import { chunkFiles, historyMessages, runSteps, wordsOf } from './workload.mjs';

declare const self: DedicatedWorkerGlobalScope;

export const LOCK_NAME = 'brainstrike-spike-state-db';
export const POOL = { directory: '.brainstrike-sahpool', name: 'brainstrike-sahpool' } as const;

// biome-ignore lint/suspicious/noExplicitAny: the sqlite-wasm oo1 surface is untyped JS here.
type Db = any;
// biome-ignore lint/suspicious/noExplicitAny: SAHPoolUtil from the official build.
type Pool = any;

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>> | undefined;
let pool: Pool | undefined;
let state: Db | undefined;
let index: Db | undefined;
let releaseLock: (() => void) | undefined;
const words = wordsOf(recorded.patterns);
const now = () => performance.now();

function takeLock(wait: boolean): Promise<boolean> {
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(LOCK_NAME, { ifAvailable: !wait, mode: 'exclusive' }, (lock) => {
        if (!lock) {
          resolve(false);
          return;
        }
        return new Promise<void>((release) => {
          releaseLock = release;
          resolve(true);
        });
      })
      .catch(reject);
  });
}

/** ADR-0011 web PRAGMAs: EXCLUSIVE before WAL, so SQLite keeps the wal-index in heap (no xShm). */
function configure(db: Db): Record<string, unknown> {
  db.exec('PRAGMA locking_mode=EXCLUSIVE');
  const journal = db.selectValue('PRAGMA journal_mode=WAL');
  db.exec(
    'PRAGMA synchronous=NORMAL; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON; PRAGMA wal_autocheckpoint=0;'
  );
  return {
    journalMode: journal,
    lockingMode: db.selectValue('PRAGMA locking_mode'),
    pageSize: db.selectValue('PRAGMA page_size'),
    secureDelete: db.selectValue('PRAGMA secure_delete'),
    synchronous: db.selectValue('PRAGMA synchronous'),
  };
}

async function open(input: { wait: boolean; failOnce?: boolean }) {
  const started = now();
  if (!(await takeLock(input.wait))) {
    return { leader: false };
  }
  const locked = now();
  sqlite3 ??= await sqlite3InitModule();
  const initialized = now();
  if (input.failOnce) {
    injectOneAcquisitionFailure();
  }
  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({ ...POOL, initialCapacity: 8 });
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    releaseLock?.();
    releaseLock = undefined;
    return { installError: message, leader: true };
  }
  const installed = now();
  state = new pool.OpfsSAHPoolDb('/state.db');
  const statePragmas = configure(state);
  const migrated = migrateState(state, UPGRADES, SCHEMA_VERSION);
  const stateReady = now();
  index = new pool.OpfsSAHPoolDb('/state-index.sqlite');
  const indexPragmas = configure(index);
  const fresh = Number(index.selectValue('SELECT count(*) FROM sqlite_schema')) === 0;
  const ddl = fresh
    ? [
        ...replayObjects(index, schema.index.objects),
        ...applyFtsConfig(index, schema.index.ftsConfig),
      ]
    : [];
  const ready = now();
  return {
    capacity: pool.getCapacity(),
    ddlErrors: ddl.filter((outcome: { outcome: string }) => outcome.outcome === 'error'),
    ddlSkipped: ddl.filter((outcome: { outcome: string }) => outcome.outcome === 'skipped').length,
    files: pool.getFileNames(),
    fresh,
    indexDiff: diffSchema(
      schema.index.objects.filter(
        (object: { name: string }) => !object.name.startsWith('vec_chunks')
      ),
      readSchema(index)
    ),
    indexPragmas,
    leader: true,
    migrated,
    sqlite: sqlite3.version.libVersion,
    stateDiff: diffSchema(schema.state.objects, readSchema(state)),
    statePragmas,
    timings: {
      indexMs: ready - stateReady,
      initMs: initialized - locked,
      installMs: installed - initialized,
      lockMs: locked - started,
      stateMs: stateReady - installed,
      totalMs: ready - started,
    },
  };
}

/** The forum 5664cd4b reproduction: one pool file's handle acquisition fails once, after 200 ms. */
function injectOneAcquisitionFailure(): void {
  const proto = FileSystemFileHandle.prototype as unknown as {
    createSyncAccessHandle: (...args: unknown[]) => Promise<unknown>;
  };
  const original = proto.createSyncAccessHandle;
  let failed = false;
  proto.createSyncAccessHandle = function (this: FileSystemFileHandle, ...args: unknown[]) {
    if (!(failed || this.name.startsWith('.opfs-sahpool-sync-check'))) {
      failed = true;
      return new Promise((_, reject) =>
        setTimeout(() => reject(new DOMException('simulated', 'UnknownError')), 200)
      );
    }
    return original.apply(this, args);
  };
}

/** run-log.mjs append + boundary, statement for statement (crc32 in JS instead of node:zlib). */
function appendRun(input: { threadId: string; steps: number; seed: number }) {
  const db = state;
  const tail = Number(
    db.selectValue('SELECT coalesce(max(seq),0) FROM run_events WHERE thread_id=?', [
      input.threadId,
    ])
  );
  const batches = runSteps({
    runId: `run-${input.seed}`,
    seed: input.seed,
    startSeq: tail + 1,
    steps: input.steps,
    threadId: input.threadId,
    words,
  });
  const batchMs: number[] = [];
  const boundaryMs: number[] = [];
  let checkpoints = 0;
  let bytes = 0;
  for (const batch of batches) {
    const at = Date.now();
    const begun = now();
    db.transaction(() => {
      for (const row of batch) {
        const payload = `{"seq":${row.seq},${row.body.slice(1)}`;
        bytes += payload.length;
        db.exec({
          bind: [
            input.threadId,
            row.seq,
            row.type,
            `run-${input.seed}`,
            payload,
            crc32(payload),
            null,
            at,
            1,
          ],
          sql: 'INSERT INTO run_events (thread_id, seq, type, run_id, payload, crc, raw_count, created_at, hydrate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        });
        db.exec({
          bind: [input.threadId, row.seq, at, at],
          sql: 'INSERT INTO threads (id,last_seq,created_at,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seq=excluded.last_seq, updated_at=excluded.updated_at',
        });
      }
    });
    const committed = now();
    const probe = db.selectArray('PRAGMA wal_checkpoint(NOOP)');
    if (probe && Number(probe[1]) >= 1000) {
      db.exec('PRAGMA wal_checkpoint(PASSIVE)');
      checkpoints += 1;
    }
    db.exec('PRAGMA synchronous=FULL');
    db.exec({
      bind: [input.threadId, (batch.at(-1) as { seq: number }).seq, Date.now()],
      sql: 'INSERT INTO run_sync (thread_id, seq, at) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET seq = excluded.seq, at = excluded.at',
    });
    db.exec('PRAGMA synchronous=NORMAL');
    batchMs.push(committed - begun);
    boundaryMs.push(now() - committed);
  }
  return { batchMs, boundaryMs, bytes, checkpoints, rows: batches.flat().length };
}

/** IndexerPort commitTextFile shape: file_records + file_chunks (FTS5 + trigram triggers) in one transaction. */
function indexChunks(input: {
  files: number;
  fileOffset: number;
  chunksPerFile: number;
  linesPerChunk: number;
  seed: number;
}) {
  const files = chunkFiles({ ...input, rootId: 'web-root', words });
  const begun = now();
  index.transaction(() => {
    for (const { chunks, file } of files) {
      index.exec({
        bind: [file.id, file.root_id, file.name, file.path, file.content_hash, file.snapshot_hash],
        sql: 'INSERT INTO file_records(id,root_id,name,path,content_hash,snapshot_hash) VALUES(?,?,?,?,?,?)',
      });
      for (const chunk of chunks) {
        index.exec({
          bind: [
            chunk.id,
            chunk.root_id,
            chunk.file_record_id,
            chunk.start_line,
            chunk.end_line,
            chunk.content,
            chunk.content_hash,
            chunk.chunk_index,
            chunk.chunk_size,
            chunk.chunk_type,
            chunk.start_offset,
            chunk.end_offset,
            chunk.token_count,
          ],
          sql: 'INSERT INTO file_chunks(id,root_id,file_record_id,start_line,end_line,content,content_hash,chunk_index,chunk_size,chunk_type,start_offset,end_offset,token_count,has_vector) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0)',
        });
      }
    }
  });
  return {
    chunks: files.reduce((total, file) => total + file.chunks.length, 0),
    ms: now() - begun,
  };
}

function indexHistory(input: { threads: number; perThread: number; seed: number }) {
  const messages = historyMessages({ ...input, words: recorded.patterns });
  const begun = now();
  index.transaction(() => {
    for (const message of messages) {
      index.exec({
        bind: [message.pk, message.threadId, message.seq, message.payload, message.text],
        sql: 'INSERT INTO state_event_rows(pk,thread_id,seq,payload,content) VALUES(?,?,?,?,?)',
      });
      index.exec({
        bind: [
          message.pk,
          message.threadId,
          message.seq,
          message.runId,
          message.role,
          message.text,
        ],
        sql: 'INSERT INTO state_search_rows(event_pk,thread_id,seq,run_id,role,text) VALUES(?,?,?,?,?,?)',
      });
    }
  });
  return { messages: messages.length, ms: now() - begun };
}

const quote = (text: string) => `"${text.replaceAll('"', '""')}"`;

/** The production query shapes: store.ts bm25, sandbox.grep trigram candidates, state-event-store search. */
function search(input: { queries: readonly string[] }) {
  const bm25: number[] = [];
  const grep: number[] = [];
  const history: number[] = [];
  let hits = 0;
  const threads = JSON.stringify(
    index.selectValues('SELECT DISTINCT thread_id FROM state_search_rows ORDER BY thread_id')
  );
  for (const query of input.queries) {
    const expression = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).map(quote).join(' OR ');
    let begun = now();
    if (expression) {
      hits += index.selectArrays(
        'SELECT c.id,bm25(file_chunks_fts) AS score FROM file_chunks_fts JOIN file_chunks c ON c.pk=file_chunks_fts.rowid JOIN file_records f ON f.root_id=c.root_id AND f.id=c.file_record_id WHERE file_chunks_fts MATCH ? AND c.root_id=? ORDER BY score,c.id LIMIT 21',
        [expression, 'web-root']
      ).length;
      bm25.push(now() - begun);
    }
    begun = now();
    const plan = planGrepTrigramCandidates(query, true, false);
    const matcher = createGrepLineMatcher(query, true, false);
    const rows =
      plan.kind === 'candidates'
        ? index.selectArrays(
            'SELECT ch.id,ch.content FROM file_chunks ch WHERE ch.root_id=? AND ch.rowid IN (SELECT rowid FROM file_chunks_trigram WHERE file_chunks_trigram MATCH ?) ORDER BY ch.id',
            ['web-root', plan.match]
          )
        : index.selectArrays(
            'SELECT ch.id,ch.content FROM file_chunks ch WHERE ch.root_id=? ORDER BY ch.id',
            ['web-root']
          );
    hits += rows.filter((row: [string, string]) =>
      row[1].split('\n').some((line) => matcher.matches(line))
    ).length;
    grep.push(now() - begun);
    const historyWords = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (historyWords.length > 0) {
      begun = now();
      hits += index.selectArrays(
        `SELECT s.thread_id,s.seq,bm25(state_search_fts) AS rank,snippet(state_search_fts,0,'<mark>','</mark>',' … ',18)
         FROM state_search_fts JOIN state_search_rows s ON s.event_pk=state_search_fts.rowid
         WHERE state_search_fts MATCH ? AND s.thread_id IN (SELECT value FROM json_each(?))
         ORDER BY rank,s.thread_id,s.seq LIMIT 20`,
        [historyWords.slice(0, 3).map(quote).join(' OR '), threads]
      ).length;
      history.push(now() - begun);
    }
  }
  return { bm25, grep, history, hits };
}

function counts() {
  return {
    chunks: Number(index.selectValue('SELECT count(*) FROM file_chunks')),
    events: Number(state.selectValue('SELECT count(*) FROM run_events')),
    indexIntegrity: index.selectValue('PRAGMA integrity_check'),
    indexPages: Number(index.selectValue('PRAGMA page_count')),
    stateIntegrity: state.selectValue('PRAGMA integrity_check'),
    statePages: Number(state.selectValue('PRAGMA page_count')),
    threads: state.selectArrays('SELECT id,last_seq FROM threads ORDER BY id'),
  };
}

/** One committed row whose payload carries a unique marker, for physical-absence scans after delete. */
function appendMarker(input: { threadId: string; marker: string; rows: number }) {
  const tail = Number(
    state.selectValue('SELECT coalesce(max(seq),0) FROM run_events WHERE thread_id=?', [
      input.threadId,
    ])
  );
  const at = Date.now();
  state.transaction(() => {
    for (let offset = 1; offset <= input.rows; offset++) {
      const seq = tail + offset;
      const payload = `{"seq":${seq},"type":"prompt","prompt":"${input.marker} ${offset}"}`;
      state.exec({
        bind: [input.threadId, seq, 'prompt', 'run-marker', payload, crc32(payload), null, at, 1],
        sql: 'INSERT INTO run_events (thread_id, seq, type, run_id, payload, crc, raw_count, created_at, hydrate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      });
      state.exec({
        bind: [input.threadId, seq, at, at],
        sql: 'INSERT INTO threads (id,last_seq,created_at,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seq=excluded.last_seq, updated_at=excluded.updated_at',
      });
    }
  });
  return { tail: tail + input.rows };
}

function deleteThread(input: { threadId: string }) {
  state.transaction(() => {
    state.exec({ bind: [input.threadId], sql: 'DELETE FROM run_events WHERE thread_id = ?' });
    state.exec({ bind: [input.threadId], sql: 'DELETE FROM run_sync WHERE thread_id = ?' });
    state.exec({ bind: [input.threadId], sql: 'DELETE FROM threads WHERE id = ?' });
  });
  return {
    remaining: Number(
      state.selectValue('SELECT count(*) FROM run_events WHERE thread_id=?', [input.threadId])
    ),
  };
}

/** Keeps committing until the process dies (crash tests). Acks after the first commit. */
function writeForever(input: { threadId: string; ack: (value: unknown) => void }) {
  let step = 0;
  for (;;) {
    appendRun({ seed: 10_000 + step, steps: 1, threadId: input.threadId });
    if (step === 0) {
      input.ack({ started: true });
    }
    step += 1;
  }
}

/** A second writer that skips the Web Lock: proves what the VFS itself does when a leader holds the pool. */
async function openUnlocked() {
  sqlite3 ??= await sqlite3InitModule();
  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({ ...POOL, initialCapacity: 8 });
    return { files: pool.getFileNames(), installed: true };
  } catch (error) {
    return {
      installError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

/** The desktop reopen verifier (run-log.mjs): every row's crc, and per-thread seq contiguity. */
function verify() {
  const rows = state.selectArrays(
    'SELECT thread_id, seq, payload, crc FROM run_events ORDER BY thread_id, seq'
  );
  const tails = new Map<string, number>();
  let badCrc = 0;
  let gaps = 0;
  for (const [threadId, seq, payload, crc] of rows as [string, number, string, number][]) {
    badCrc += crc32(payload) === Number(crc) ? 0 : 1;
    gaps += Number(seq) === (tails.get(threadId) ?? 0) + 1 ? 0 : 1;
    tails.set(threadId, Number(seq));
  }
  return {
    badCrc,
    gaps,
    integrity: state.selectValue('PRAGMA integrity_check'),
    rows: rows.length,
    tails: Object.fromEntries(tails),
  };
}

function closeAll(): void {
  index?.close();
  state?.close();
  index = undefined;
  state = undefined;
}

/** Retire: close, release every sync access handle, then the lock. Files stay. */
function retire() {
  closeAll();
  pool?.pauseVfs();
  releaseLock?.();
  releaseLock = undefined;
  return { paused: pool?.isPaused() ?? true };
}

/** Factory reset from inside the lock holder: close, delete the pool directory, then release. */
async function wipe() {
  closeAll();
  const removed = (await pool?.removeVfs()) ?? false;
  pool = undefined;
  releaseLock?.();
  releaseLock = undefined;
  return { removed };
}

self.onmessage = async (event: MessageEvent<{ id: number; command: string; input: never }>) => {
  const { command, id, input } = event.data;
  const reply = (value: unknown) => self.postMessage({ id, value });
  try {
    switch (command) {
      case 'open':
        return reply(await open(input));
      case 'appendRun':
        return reply(appendRun(input));
      case 'indexChunks':
        return reply(indexChunks(input));
      case 'indexHistory':
        return reply(indexHistory(input));
      case 'search':
        return reply(search(input));
      case 'counts':
        return reply(counts());
      case 'deleteThread':
        return reply(deleteThread(input));
      case 'openUnlocked':
        return reply(await openUnlocked());
      case 'verify':
        return reply(verify());
      case 'checkpoint':
        return reply({
          index: index.selectArray('PRAGMA wal_checkpoint(TRUNCATE)'),
          state: state.selectArray('PRAGMA wal_checkpoint(TRUNCATE)'),
        });
      case 'appendMarker':
        return reply(appendMarker(input));
      case 'writeForever':
        return writeForever({ ...(input as { threadId: string }), ack: reply });
      case 'retire':
        return reply(retire());
      case 'wipe':
        return reply(await wipe());
      default:
        throw new Error(`unknown command ${command}`);
    }
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      id,
    });
  }
};
