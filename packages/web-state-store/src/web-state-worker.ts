/**
 * The browser state writer (ADR-0011). Every tab runs one of these workers.
 * The worker that holds the origin's exclusive Web Lock is the writer: only
 * it installs the `opfs-sahpool` VFS and opens the state DB, with the shared
 * schema and run log from `@brainstrike/state-store`. Every other worker
 * forwards its tab's requests to the writer over a BroadcastChannel. When the
 * writer's tab goes, the lock passes to a waiting worker, which opens the
 * store under the next epoch.
 *
 * A forwarded request is never sent twice. If the writer changes before it
 * answers, the request fails as `leader-lost`: it may or may not have been
 * applied, and its caller decides what to read back.
 */

import {
  isCorrupt,
  RunLog,
  ThreadDamage,
  ThreadReadOnlyRefusal,
} from '@brainstrike/state-store/run-log';
import { blobsOf } from '@brainstrike/state-store/run-log-format';
import { migrate } from '@brainstrike/state-store/schema';
import { CheckpointBlockedError } from '@brainstrike/state-store/sqlite-checkpoint';
import sqlite3InitModule, {
  type Database,
  type SAHPoolUtil,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm';
import type BetterSqlite3 from 'better-sqlite3';
import {
  type ChannelMessage,
  type TabMessage,
  type WebStateErrorReply,
  type WebStateLease,
  type WebStateReply,
  type WebStateRequest,
  type WebStateRequests,
  type WebStateStoreConfig,
  type WorkerMessage,
  webStateNames,
} from './protocol';
import { SqliteWasmDatabase } from './sqlite-wasm-database';

declare const self: DedicatedWorkerGlobalScope;

/** The desktop writer's checkpoint threshold (`StateStore` `checkpointPages`). */
const CHECKPOINT_PAGES = 1000;
const STATE_DB_FILE = '/state.db';
/** The writer record: the lease's epoch, apart from the state DB's shared schema. */
const WRITER_DB_FILE = '/writer.db';
const WRITER_SCHEMA = `CREATE TABLE IF NOT EXISTS writer (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  instance_id TEXT NOT NULL,
  acquired_at REAL NOT NULL
) STRICT`;

type AppendRows = Parameters<RunLog['append']>[0];

interface Writer {
  readonly db: SqliteWasmDatabase;
  readonly log: RunLog;
}

const instanceId = crypto.randomUUID();
let config: WebStateStoreConfig | undefined;
let channel: BroadcastChannel | undefined;
/** The newest writer this worker knows of; its own lease while it writes. */
let lease: WebStateLease | undefined;
let writer: Writer | undefined;
let failure: string | undefined;
/** This tab's requests forwarded to a writer, by request id: the writer each went to. */
const forwarded = new Map<number, string>();
/** This tab's requests waiting for a writer to be known. */
const waiting: { id: number; request: WebStateRequest }[] = [];

function toTab(message: WorkerMessage): void {
  self.postMessage(message);
}

function broadcast(message: ChannelMessage): void {
  channel?.postMessage(message);
}

function errorReply(error: unknown): WebStateErrorReply {
  if (error instanceof ThreadReadOnlyRefusal) {
    return { error: error.message, errorKind: 'readonly', threadId: error.threadId };
  }
  if (error instanceof ThreadDamage) {
    return {
      atSeq: error.atSeq,
      detail: error.detail,
      error: error.message,
      errorKind: 'damaged',
      threadId: error.threadId,
    };
  }
  if (error instanceof CheckpointBlockedError) {
    return { error: error.message, errorKind: 'checkpoint-blocked' };
  }
  const cause = error as Error | undefined;
  return { error: String(cause?.stack ?? cause), errorKind: 'failed' };
}

function leaderLost(): WebStateErrorReply {
  return {
    error:
      'The state writer changed before answering; the request may or may not have been applied.',
    errorKind: 'leader-lost',
  };
}

function unavailable(): WebStateErrorReply {
  return { error: `The state store is unavailable: ${failure}`, errorKind: 'unavailable' };
}

/** better-sqlite3's API, as the shared modules type their connection. */
function asBetterSqlite3(db: SqliteWasmDatabase): BetterSqlite3.Database {
  return db as unknown as BetterSqlite3.Database;
}

/**
 * The forum 5664cd4b reproduction: one pool file's access-handle acquisition
 * fails after 200 ms, once the pool's other handles are acquired. The engine's
 * own API probe (`.opfs-sahpool-sync-check-*`) runs before the pool and is
 * left alone.
 */
function failNextAccessHandle(): void {
  const proto = FileSystemFileHandle.prototype as unknown as {
    createSyncAccessHandle: (this: FileSystemFileHandle, ...args: unknown[]) => Promise<unknown>;
  };
  const original = proto.createSyncAccessHandle;
  proto.createSyncAccessHandle = function failOnce(this: FileSystemFileHandle, ...args: unknown[]) {
    if (this.name.startsWith('.opfs-sahpool-sync-check')) {
      return original.apply(this, args);
    }
    proto.createSyncAccessHandle = original;
    return new Promise((_resolve, reject) =>
      setTimeout(
        () =>
          reject(new DOMException('Injected access-handle failure', 'NoModificationAllowedError')),
        200
      )
    );
  };
}

/**
 * ADR-0011's web PRAGMAs. EXCLUSIVE comes before WAL, so SQLite keeps the
 * WAL index in heap memory; the VFS has no shared memory. The rest match the
 * desktop writer: NORMAL sync with FULL at step boundaries, zeroed deletes,
 * foreign keys and checkpoints only at boundaries.
 */
function configure(db: SqliteWasmDatabase): string | null {
  db.pragma('locking_mode = EXCLUSIVE');
  const journal = db.pragma('journal_mode = WAL', { simple: true });
  if (journal !== 'wal') {
    throw new Error(`state DB journal mode is ${String(journal)}, not wal`);
  }
  db.pragma('synchronous = NORMAL');
  db.pragma('secure_delete = ON');
  db.pragma('foreign_keys = ON');
  db.pragma('wal_autocheckpoint = 0');
  try {
    // One row per problem, in a column SQLite names after the pragma.
    const rows = (db.pragma('integrity_check') as Record<string, unknown>[]).map((row) =>
      String(row['integrity_check'])
    );
    return rows.length === 1 && rows[0] === 'ok' ? null : rows.join('; ');
  } catch (error) {
    if (!isCorrupt(error)) {
      throw error;
    }
    return String((error as Error).message);
  }
}

/**
 * Records this worker as the next writer and returns its epoch. The record
 * has its own database in the pool, so a damaged state DB, which opens
 * read-only, still gets an epoch above every earlier writer's.
 */
function recordWriter(sqlite3: Sqlite3Static, pool: SAHPoolUtil): number {
  const db = new SqliteWasmDatabase(
    sqlite3,
    new pool.OpfsSAHPoolDb(WRITER_DB_FILE),
    WRITER_DB_FILE
  );
  try {
    db.pragma('locking_mode = EXCLUSIVE');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.exec(WRITER_SCHEMA);
    return db.transaction(() => {
      const previous = db.prepare('SELECT epoch FROM writer WHERE id = 1').pluck().get();
      const epoch = (typeof previous === 'number' ? previous : 0) + 1;
      db.prepare(
        'INSERT INTO writer (id, epoch, instance_id, acquired_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch, instance_id = excluded.instance_id, acquired_at = excluded.acquired_at'
      ).run(epoch, instanceId, Date.now());
      return epoch;
    })();
  } finally {
    db.close();
  }
}

async function openWriter(
  sqlite3: Sqlite3Static,
  store: WebStateStoreConfig
): Promise<{ readonly lease: WebStateLease; readonly writer: Writer }> {
  if (store.testHooks?.failPoolInitOnce) {
    failNextAccessHandle();
  }
  const pool: SAHPoolUtil = await sqlite3.installOpfsSAHPoolVfs({
    directory: store.poolDirectory,
    name: `brainstrike-${store.name}`,
  });
  const epoch = recordWriter(sqlite3, pool);
  const connection: Database = new pool.OpfsSAHPoolDb(STATE_DB_FILE);
  const db = new SqliteWasmDatabase(sqlite3, connection, STATE_DB_FILE);
  try {
    const damage = configure(db);
    if (damage) {
      db.pragma('query_only = ON');
    } else {
      migrate(asBetterSqlite3(db));
    }
    return {
      lease: { epoch, instanceId },
      writer: { db, log: new RunLog(asBetterSqlite3(db), damage) },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

function settings(db: SqliteWasmDatabase): WebStateRequests['settings']['result'] {
  const value = (pragma: string) => db.pragma(pragma, { simple: true });
  return {
    foreignKeys: Number(value('foreign_keys')),
    journalMode: String(value('journal_mode')),
    lockingMode: String(value('locking_mode')),
    secureDelete: Number(value('secure_delete')),
    sqliteVersion: String(db.prepare('SELECT sqlite_version()').pluck().get()),
    synchronous: Number(value('synchronous')),
    userVersion: Number(value('user_version')),
    walAutocheckpoint: Number(value('wal_autocheckpoint')),
  };
}

/** One request on the writer, as the desktop writer worker handles the same op. */
function handle({ db, log }: Writer, request: WebStateRequest): unknown {
  switch (request.op) {
    case 'append': {
      const { boundary = false, rows } = request.params as WebStateRequests['append']['params'];
      for (const row of rows) {
        if (blobsOf(row[3]).length > 0) {
          throw new Error(
            'The browser state store has no blob storage; this event references a blob.'
          );
        }
      }
      if (boundary) {
        db.pragma('synchronous = FULL');
      }
      const ts = Date.now();
      try {
        // Structured clone delivers the rows as plain mutable arrays.
        return { seqs: log.append(rows as unknown as AppendRows, ts, boundary), ts };
      } finally {
        if (boundary) {
          db.pragma('synchronous = NORMAL');
        }
      }
    }
    case 'boundary': {
      const { threadId } = request.params as WebStateRequests['boundary']['params'];
      return { checkpoint: log.boundary(threadId, 'boundary', CHECKPOINT_PAGES) };
    }
    case 'check':
      return log.check();
    case 'read': {
      const { fromSeq, limit, threadId } = request.params as WebStateRequests['read']['params'];
      const read = log.readFrom(threadId, fromSeq, limit);
      return { damage: read.damage ? errorReply(read.damage) : null, rows: read.rows };
    }
    case 'readHydration':
      return {
        threads: log.readHydration().map(({ damage, ...thread }) => ({
          ...thread,
          damage: damage ? errorReply(damage) : null,
        })),
      };
    case 'settings':
      return settings(db);
    case 'stall':
      if (!config?.testHooks?.allowStall) {
        throw new Error('stall is a test hook');
      }
      return new Promise<never>(() => {});
    case 'status': {
      const { threadId } = request.params as WebStateRequests['status']['params'];
      return { status: log.status(threadId) };
    }
    case 'threads':
      return { threads: log.threads() };
    default:
      throw new Error(`unknown op ${String((request as { op: unknown }).op)}`);
  }
}

async function answer(
  active: Writer,
  id: number,
  request: WebStateRequest
): Promise<WebStateReply> {
  try {
    return { id, ok: true, result: await handle(active, request) };
  } catch (error) {
    return { error: errorReply(error), id, ok: false };
  }
}

/** Sends this tab's request to the writer, or holds it until one is known. */
function dispatch(id: number, request: WebStateRequest): void {
  if (failure !== undefined) {
    toTab({ error: unavailable(), id, kind: 'reply', ok: false });
    return;
  }
  if (writer) {
    const active = writer;
    void answer(active, id, request).then((reply) => toTab({ kind: 'reply', ...reply }));
    return;
  }
  if (!lease) {
    waiting.push({ id, request });
    return;
  }
  forwarded.set(id, lease.instanceId);
  broadcast({ from: instanceId, id, kind: 'request', request, to: lease.instanceId });
}

/** A newer writer: requests the old one never answered fail; held ones go to the new one. */
function adopt(next: WebStateLease, leader: boolean): void {
  lease = next;
  for (const [id, to] of forwarded) {
    if (to !== next.instanceId) {
      forwarded.delete(id);
      toTab({ error: leaderLost(), id, kind: 'reply', ok: false });
    }
  }
  toTab({ kind: 'lease', leader, lease: next });
  for (const held of waiting.splice(0)) {
    dispatch(held.id, held.request);
  }
}

function onChannel(message: ChannelMessage): void {
  switch (message.kind) {
    case 'who':
      if (writer && lease) {
        broadcast({ kind: 'leader', lease });
      }
      return;
    case 'leader':
      // Announcements from different workers can arrive out of order; only a newer epoch counts.
      if (!writer && (lease === undefined || message.lease.epoch > lease.epoch)) {
        adopt(message.lease, false);
      }
      return;
    case 'request': {
      const active = writer;
      if (active && message.to === instanceId) {
        void answer(active, message.id, message.request).then((reply) =>
          broadcast({ kind: 'reply', to: message.from, ...reply })
        );
      }
      return;
    }
    case 'reply':
      if (message.to === instanceId && forwarded.delete(message.id)) {
        const { kind: _channelKind, to: _to, ...reply } = message;
        toTab({ kind: 'reply', ...reply });
      }
      return;
  }
}

async function lead(store: WebStateStoreConfig, sqlite3: Promise<Sqlite3Static>): Promise<void> {
  const opened = await openWriter(await sqlite3, store);
  writer = opened.writer;
  broadcast({ kind: 'leader', lease: opened.lease });
  adopt(opened.lease, true);
}

function start(store: WebStateStoreConfig): void {
  config = store;
  const names = webStateNames(store.name);
  channel = new BroadcastChannel(names.channel);
  channel.onmessage = (event: MessageEvent<ChannelMessage>) => onChannel(event.data);
  broadcast({ kind: 'who' });
  // Load the engine while waiting for the lock, so a takeover only opens the store.
  const sqlite3 = sqlite3InitModule();
  void navigator.locks
    .request(names.lock, { mode: 'exclusive' }, async () => {
      await lead(store, sqlite3);
      // Hold the lock for this worker's lifetime: it is released when the tab closes the worker.
      return new Promise<never>(() => {});
    })
    .catch((error: unknown) => {
      failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      channel?.close();
      channel = undefined;
      toTab({ error: failure, kind: 'failed' });
      for (const held of waiting.splice(0)) {
        toTab({ error: unavailable(), id: held.id, kind: 'reply', ok: false });
      }
      // The lock came here, so the writer those went to is gone.
      for (const id of forwarded.keys()) {
        toTab({ error: leaderLost(), id, kind: 'reply', ok: false });
      }
      forwarded.clear();
    });
}

self.onmessage = (event: MessageEvent<TabMessage>) => {
  const message = event.data;
  if (message.kind === 'open') {
    if (config) {
      throw new Error('The state worker is already open');
    }
    start(message.config);
    return;
  }
  dispatch(message.id, message.request);
};
