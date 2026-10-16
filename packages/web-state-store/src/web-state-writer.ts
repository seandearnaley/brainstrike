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
  executeCollectionRequest,
  executeModelChoiceRequest,
  executePromptCatalogRequest,
  executeSourceCatalogRequest,
  executeThreadGroups,
  executeViewFilterPresetRequest,
  executeWorkspaceRootRequest,
} from '@brainstrike/state-store/catalog-domains';
import {
  acknowledgeSourceGc,
  deleteDeletionIntent,
  deleteThreadTruth,
  deletionIntents,
  okThreads,
  purgeEvent,
  recordDeletionIntent,
  sourceBlobRefs,
  sourceGcCandidates,
} from '@brainstrike/state-store/deletion-domain';
import { RunLog, ThreadDamage, ThreadReadOnlyRefusal } from '@brainstrike/state-store/run-log';
import { blobsOf } from '@brainstrike/state-store/run-log-format';
import { CheckpointBlockedError } from '@brainstrike/state-store/sqlite-checkpoint';
import { type DeletionWriter, StateDeletion } from '@brainstrike/state-store/state-deletion';
import sqlite3InitModule, {
  type Database,
  type SAHPoolUtil,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm';
import { SqliteBlobStore } from './blob-store';
import {
  extensionOps,
  type WebStateExtension,
  type WebStateExtensionHandlers,
  type WebStateExtensionInstance,
} from './extension';
import {
  type ChannelMessage,
  isWebRootPath,
  type TabMessage,
  type WebStateAppendRow,
  type WebStateErrorReply,
  type WebStateLease,
  type WebStateReply,
  type WebStateRequests,
  type WebStateStoreConfig,
  type WireRequest,
  type WorkerMessage,
  webStateNames,
  webStateWireProtocol,
} from './protocol';
import { asBetterSqlite3, SqliteWasmDatabase } from './sqlite-wasm-database';
import { openStateDb } from './state-db-open';

declare const self: DedicatedWorkerGlobalScope;

/** The desktop writer's checkpoint threshold (`StateStore` `checkpointPages`). */
const CHECKPOINT_PAGES = 1000;
const STATE_DB_FILE = '/state.db';
/** Content-addressed blobs, apart from the state DB's shared schema. */
const BLOBS_DB_FILE = '/blobs.db';
const POOL_CAPACITY = 16;
/** The writer record: the lease's epoch, apart from the state DB's shared schema. */
const WRITER_DB_FILE = '/writer.db';
const WRITER_SCHEMA = `CREATE TABLE IF NOT EXISTS writer (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  instance_id TEXT NOT NULL,
  acquired_at REAL NOT NULL
) STRICT`;
const RETIRED = 'The state store was retired for factory reset; reload the tab to open it again.';

type AppendRows = Parameters<RunLog['append']>[0];

interface Writer {
  readonly blobs: SqliteBlobStore;
  readonly db: SqliteWasmDatabase;
  /** Purge, thread delete and blob GC: desktop's orchestration, over this writer's connections. */
  readonly deletion: StateDeletion;
  readonly extensions: readonly WebStateExtensionInstance[];
  /** The extensions' ops, by name. */
  readonly handlers: ReadonlyMap<string, WebStateExtensionHandlers[string]>;
  readonly log: RunLog;
  readonly pool: SAHPoolUtil;
}

const instanceId = crypto.randomUUID();
/** What this worker composes beside the state DB, and the protocol that names it. */
let extensions: readonly WebStateExtension[] = [];
let wireProtocol = webStateWireProtocol([]);
/** Withdraws this worker's wait for the lock once it may never write. */
const lockWait = new AbortController();
let config: WebStateStoreConfig | undefined;
let channel: BroadcastChannel | undefined;
/** The newest writer this worker knows of; its own lease while it writes. */
let lease: WebStateLease | undefined;
let writer: Writer | undefined;
/** Set once this worker can no longer serve its tab: why, as every later request hears it. */
let refusal: WebStateErrorReply | undefined;
let retired = false;
/** This tab's requests forwarded to a writer, by request id: the writer each went to. */
const forwarded = new Map<number, string>();
/** This tab's requests waiting for a writer to be known. */
const waiting: { id: number; request: WireRequest }[] = [];

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
  const code: unknown = cause instanceof Error ? Reflect.get(cause, 'code') : undefined;
  if (typeof code === 'string' && cause instanceof Error) {
    return { code, error: cause.message, errorKind: 'failed' };
  }
  return { error: String(cause?.stack ?? cause), errorKind: 'failed' };
}

function leaderLost(): WebStateErrorReply {
  return {
    error:
      'The state writer changed before answering; the request may or may not have been applied.',
    errorKind: 'leader-lost',
  };
}

/** Fails everything this tab still waits on with `reply`. */
function failOutstanding(reply: WebStateErrorReply): void {
  for (const held of waiting.splice(0)) {
    toTab({ error: reply, id: held.id, kind: 'reply', ok: false });
  }
  for (const id of forwarded.keys()) {
    toTab({ error: reply, id, kind: 'reply', ok: false });
  }
  forwarded.clear();
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

/** The deletion ops on this writer's connections, as desktop's writer worker serves them (`deletion-domain.mjs`). */
function deletionWriter(
  db: SqliteWasmDatabase,
  log: RunLog,
  blobs: SqliteBlobStore
): DeletionWriter {
  const native = asBetterSqlite3(db);
  return {
    acknowledgeSourceGc: async (hashes) => acknowledgeSourceGc(native, hashes),
    damagedBlobRefs: async () => log.damagedBlobRefs(),
    deleteIntent: async (threadId, seq) => deleteDeletionIntent(native, threadId, seq),
    // No memory calculator runs in the browser, so no observation tokens are recounted.
    deleteThread: async (threadId) => deleteThreadTruth(native, log, threadId),
    eventRaw: async (threadId, seq) => {
      const read = log.readFrom(threadId, seq, 1);
      if (read.damage) {
        throw read.damage;
      }
      const [row] = read.rows;
      return row && row.seq === seq ? row.payload : undefined;
    },
    intents: async () =>
      deletionIntents(native).map((intent) => ({
        ...intent,
        hashes: JSON.parse(intent.hashes) as string[],
      })),
    okThreads: async () => okThreads(log),
    purge: async (threadId, seq, tombstone) => purgeEvent(native, log, threadId, seq, tombstone),
    recordIntent: async (intent) =>
      JSON.parse(
        recordDeletionIntent(native, { ...intent, hashes: JSON.stringify(intent.hashes) })
      ) as string[],
    sourceBlobRefs: async () => sourceBlobRefs(native),
    sourceGcCandidates: async () => sourceGcCandidates(native),
    storedBlobRefs: async (threadId) => log.storedBlobRefs(threadId),
    unlinkBlobs: async (hashes) => blobs.unlink(hashes),
  };
}

async function openWriter(
  sqlite3: Sqlite3Static,
  store: WebStateStoreConfig
): Promise<{ readonly lease: WebStateLease; readonly writer: Writer }> {
  const names = webStateNames(store.name);
  if (store.testHooks?.failPoolInitOnce) {
    failNextAccessHandle();
  }
  const pool = await sqlite3.installOpfsSAHPoolVfs({
    directory: names.pool,
    // Each database and its WAL hold a file: state, writer, blobs and the derived index, with room to spare.
    initialCapacity: POOL_CAPACITY,
    name: names.vfs,
  });
  const epoch = recordWriter(sqlite3, pool);
  // The pool's constructor takes oo1's (filename, flags); its declaration names only the filename.
  const PoolDb = pool.OpfsSAHPoolDb as unknown as new (filename: string, flags: string) => Database;
  const blobs = new SqliteBlobStore(
    new SqliteWasmDatabase(sqlite3, new PoolDb(BLOBS_DB_FILE, 'c'), BLOBS_DB_FILE)
  );
  const { damage, db } = openStateDb(
    (readOnly) =>
      new SqliteWasmDatabase(
        sqlite3,
        new PoolDb(STATE_DB_FILE, readOnly ? 'r' : 'c'),
        STATE_DB_FILE
      )
  );
  const log = new RunLog(asBetterSqlite3(db), damage);
  const opened: WebStateExtensionInstance[] = [];
  let handlers: ReadonlyMap<string, WebStateExtensionHandlers[string]>;
  let deletion: StateDeletion;
  try {
    for (const extension of extensions) {
      opened.push(
        await extension.open({
          blobs,
          config: store,
          log,
          openDatabase: (file) => new SqliteWasmDatabase(sqlite3, new PoolDb(file, 'c'), file),
          removeDatabase: (file) => {
            // A journal left beside the file would otherwise replay into the database recreated there.
            for (const suffix of ['', '-wal', '-journal']) {
              pool.unlink(`${file}${suffix}`);
            }
          },
          state: db,
        })
      );
    }
    handlers = extensionOps(opened);
    const indexers = opened.flatMap((instance) => (instance.indexer ? [instance.indexer] : []));
    if (indexers.length > 1) {
      throw new Error('Two writer extensions both provide the derived index');
    }
    let failPurge = store.testHooks?.failPurgeAfterTruthOnce === true;
    deletion = new StateDeletion(deletionWriter(db, log, blobs), {
      indexer: () => indexers[0],
      purgeAfterTruth: () => {
        if (failPurge) {
          failPurge = false;
          throw new Error('Test hook: the purge failed after its truth committed');
        }
      },
      // Every op already runs in the writer's request order (`serialized`), and an open recovers before it leads.
      run: (work) => Promise.resolve().then(work),
    });
    if (damage === null) {
      // As desktop's open: complete what a crash interrupted before serving anyone.
      await deletion.recover();
    }
  } catch (error) {
    for (const instance of opened.reverse()) {
      await instance.close();
    }
    db.close();
    blobs.close();
    throw error;
  }
  return {
    lease: { epoch, instanceId },
    writer: { blobs, db, deletion, extensions: opened, handlers, log, pool },
  };
}

function settings(db: SqliteWasmDatabase): WebStateRequests['settings']['result'] {
  const value = (pragma: string) => db.pragma(pragma, { simple: true });
  return {
    foreignKeys: Number(value('foreign_keys')),
    journalMode: String(value('journal_mode')),
    lockingMode: String(value('locking_mode')),
    pageSize: Number(value('page_size')),
    queryOnly: Number(value('query_only')),
    secureDelete: Number(value('secure_delete')),
    sqliteVersion: String(db.prepare('SELECT sqlite_version()').pluck().get()),
    synchronous: Number(value('synchronous')),
    userVersion: Number(value('user_version')),
    walAutocheckpoint: Number(value('wal_autocheckpoint')),
  };
}

/**
 * Factory reset's first step: close the store and release every OPFS handle
 * of the pool, so the reset can delete its directory. The lock stays held
 * until this tab reloads, so no other tab reopens the pool first.
 */
async function retire(active: Writer): Promise<void> {
  writer = undefined;
  retired = true;
  refusal = { error: RETIRED, errorKind: 'unavailable' };
  // An extension's own pool, in its own worker, is released before the reply lets reset delete it.
  for (const instance of [...active.extensions].reverse()) {
    await instance.close();
  }
  active.db.close();
  active.blobs.close();
  active.pool.pauseVfs();
}

/** The desktop writer's `verifyBlobReferences`: every blob an event names exists and is intact. */
function verifyBlobReferences(blobs: SqliteBlobStore, rows: readonly WebStateAppendRow[]): void {
  for (const row of rows) {
    for (const hash of blobsOf(row[3])) {
      blobs.verify(hash);
    }
  }
}

/**
 * Desktop StateStore's `sourceCatalog`: a mutation needs the derived index
 * before it commits bytes, and the sources it retires are collected after,
 * by the same GC as purge and thread delete.
 */
async function sourceCatalog(
  active: Writer,
  request: WebStateRequests['sourceCatalog']['params']
): Promise<WebStateRequests['sourceCatalog']['result']> {
  const mutates =
    request.operation === 'import' ||
    request.operation === 'prepare' ||
    request.operation === 'replace' ||
    request.operation === 'remove';
  if (mutates) {
    active.deletion.requireIndexer('canonical source mutation');
  }
  const reply = executeSourceCatalogRequest(asBetterSqlite3(active.db), request, {
    put: (hash, content) => active.blobs.put(hash, content),
    read: (hash, maxBytes) => active.blobs.read(hash, maxBytes),
  });
  if (mutates) {
    await active.deletion.collectRetiredSources();
  }
  return reply;
}

/** Desktop StateStore's `workspaceRoots`, with a root's path its handle key (`webRootPath`). */
async function workspaceRoots(
  active: Writer,
  request: WebStateRequests['workspaceRoots']['params']
): Promise<WebStateRequests['workspaceRoots']['result']> {
  if (request.operation === 'delete') {
    active.deletion.requireIndexer('root data deletion');
  }
  const reply = executeWorkspaceRootRequest(asBetterSqlite3(active.db), request, {
    // A root is named by its own id, so its handle is found under the same IndexedDB key.
    isGranted: (root) => isWebRootPath(root.path, root.preferredId),
  });
  if (request.operation === 'delete') {
    await active.deletion.collectRetiredSources();
  }
  return reply;
}

/** One request on the writer, as the desktop writer worker handles the same op. */
async function handle(active: Writer, request: WireRequest): Promise<unknown> {
  const { blobs, db, log } = active;
  const params = request.params;
  switch (request.op) {
    case 'append': {
      const { boundary = false, rows } = params as WebStateRequests['append']['params'];
      verifyBlobReferences(blobs, rows);
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
      const { threadId } = params as WebStateRequests['boundary']['params'];
      return { checkpoint: log.boundary(threadId, 'boundary', CHECKPOINT_PAGES) };
    }
    case 'check':
      return log.check();
    case 'collections':
      return executeCollectionRequest(
        asBetterSqlite3(db),
        params as WebStateRequests['collections']['params']
      );
    case 'damagedBlobRefs':
      return { hashes: log.damagedBlobRefs() };
    case 'deleteThread': {
      const { threadId } = params as WebStateRequests['deleteThread']['params'];
      return { deleted: await active.deletion.deleteThread(threadId) };
    }
    case 'modelChoices':
      return executeModelChoiceRequest(
        asBetterSqlite3(db),
        params as WebStateRequests['modelChoices']['params']
      );
    case 'promptCatalog':
      return executePromptCatalogRequest(
        asBetterSqlite3(db),
        params as WebStateRequests['promptCatalog']['params']
      );
    case 'purge': {
      const { seq, threadId } = params as WebStateRequests['purge']['params'];
      return active.deletion.purge(threadId, seq);
    }
    case 'putBlob': {
      const { content, hash } = params as WebStateRequests['putBlob']['params'];
      blobs.put(hash, content);
      return {};
    }
    case 'read': {
      const { fromSeq, limit, threadId } = params as WebStateRequests['read']['params'];
      const read = log.readFrom(threadId, fromSeq, limit);
      return { damage: read.damage ? errorReply(read.damage) : null, rows: read.rows };
    }
    case 'readBlob': {
      const { hash, maxBytes } = params as WebStateRequests['readBlob']['params'];
      return { content: blobs.read(hash, maxBytes) };
    }
    case 'readHydration':
      return {
        threads: log.readHydration().map(({ damage, ...thread }) => ({
          ...thread,
          damage: damage ? errorReply(damage) : null,
        })),
      };
    case 'retire':
      await retire(active);
      return {};
    case 'settings':
      return settings(db);
    case 'sourceCatalog':
      return sourceCatalog(active, params as WebStateRequests['sourceCatalog']['params']);
    case 'status': {
      const { threadId } = params as WebStateRequests['status']['params'];
      return { status: log.status(threadId) };
    }
    case 'storedBlobRefs': {
      const { threadId } = params as WebStateRequests['storedBlobRefs']['params'];
      return { hashes: log.storedBlobRefs(threadId) };
    }
    case 'threadGroups':
      return executeThreadGroups(
        asBetterSqlite3(db),
        params as WebStateRequests['threadGroups']['params']
      );
    case 'threads':
      return { threads: log.threads() };
    case 'workspaceRoots':
      return workspaceRoots(active, params as WebStateRequests['workspaceRoots']['params']);
    case 'viewFilterPresets':
      return executeViewFilterPresetRequest(
        asBetterSqlite3(db),
        params as WebStateRequests['viewFilterPresets']['params']
      );
    default: {
      const handler = active.handlers.get(request.op);
      if (handler) {
        return handler(params);
      }
      throw new Error(`unknown op ${String(request.op)}`);
    }
  }
}

/**
 * The writer's requests run one at a time, in arrival order, as the desktop
 * writer handles its messages: a blob write finishes before the append that
 * names it, and nothing runs on a store that a retirement already closed.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function answer(id: number, request: WireRequest): Promise<WebStateReply> {
  if (request.op === 'stall') {
    // The test hook never answers, and must not hold the queue while it waits.
    return config?.testHooks?.allowStall
      ? new Promise<never>(() => {})
      : Promise.resolve({ error: errorReply(new Error('stall is a test hook')), id, ok: false });
  }
  return serialized(async (): Promise<WebStateReply> => {
    const active = writer;
    if (!active) {
      return { error: refusal ?? leaderLost(), id, ok: false };
    }
    try {
      return { id, ok: true, result: await handle(active, request) };
    } catch (error) {
      return { error: errorReply(error), id, ok: false };
    }
  });
}

/**
 * After the reply that retired the store: tell every tab, so none reopens it.
 * Sent after that reply on the same channel, so the requester hears its own
 * answer first.
 */
function announceRetirement(): void {
  broadcast({ kind: 'retired' });
  toTab({ kind: 'retired' });
}

/** Sends this tab's request to the writer, or holds it until one is known. */
function dispatch(id: number, request: WireRequest): void {
  if (refusal) {
    toTab({ error: refusal, id, kind: 'reply', ok: false });
    return;
  }
  if (writer) {
    void answer(id, request).then((reply) => {
      toTab({ kind: 'reply', ...reply });
      if (retired && request.op === 'retire' && reply.ok) {
        announceRetirement();
      }
    });
    return;
  }
  if (!lease) {
    waiting.push({ id, request });
    return;
  }
  forwarded.set(id, lease.instanceId);
  broadcast({
    from: instanceId,
    id,
    kind: 'request',
    protocol: wireProtocol,
    request,
    to: lease.instanceId,
  });
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

/** This worker will never write or forward again: stop waiting for the lock and tell the tab. */
function withdraw(reason: WebStateErrorReply, message: WorkerMessage): void {
  refusal = reason;
  lockWait.abort();
  failOutstanding(reason);
  toTab(message);
}

type ChannelOf<Kind extends ChannelMessage['kind']> = Extract<ChannelMessage, { kind: Kind }>;

function onLeader(message: ChannelOf<'leader'>): void {
  if (message.protocol !== wireProtocol) {
    const error = `Another tab's state writer speaks protocol ${message.protocol}, this tab ${wireProtocol}; reload every Brainstrike tab.`;
    withdraw({ error, errorKind: 'unavailable' }, { error, kind: 'failed' });
    return;
  }
  // Announcements from different workers can arrive out of order; only a newer epoch counts.
  if (!writer && (lease === undefined || message.lease.epoch > lease.epoch)) {
    adopt(message.lease, false);
  }
}

function onRequest(message: ChannelOf<'request'>): void {
  if (message.to !== instanceId) {
    return;
  }
  if (message.protocol !== wireProtocol) {
    broadcast({
      error: {
        error: `This writer speaks protocol ${wireProtocol}, not ${message.protocol}`,
        errorKind: 'unavailable',
      },
      id: message.id,
      kind: 'reply',
      ok: false,
      to: message.from,
    });
    return;
  }
  void answer(message.id, message.request).then((reply) => {
    broadcast({ kind: 'reply', to: message.from, ...reply });
    if (retired && message.request.op === 'retire' && reply.ok) {
      announceRetirement();
    }
  });
}

function onChannel(message: ChannelMessage): void {
  // A withdrawn worker only collects replies. A retired writer still answers,
  // so late tabs and late requests hear that the store is retired.
  if (refusal && !retired && message.kind !== 'reply') {
    return;
  }
  switch (message.kind) {
    case 'who':
      if (writer && lease) {
        broadcast({ kind: 'leader', lease, protocol: wireProtocol });
      } else if (retired) {
        broadcast({ kind: 'retired' });
      }
      return;
    case 'leader':
      onLeader(message);
      return;
    case 'retired':
      withdraw({ error: RETIRED, errorKind: 'unavailable' }, { kind: 'retired' });
      return;
    case 'request':
      onRequest(message);
      return;
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
  broadcast({ kind: 'leader', lease: opened.lease, protocol: wireProtocol });
  adopt(opened.lease, true);
}

function start(store: WebStateStoreConfig): void {
  config = store;
  for (const extension of extensions) {
    try {
      extension.validate?.(store);
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      refusal = { error: `The state store is unavailable: ${failure}`, errorKind: 'unavailable' };
      toTab({ error: failure, kind: 'failed' });
      return;
    }
  }
  const names = webStateNames(store.name);
  channel = new BroadcastChannel(names.channel);
  channel.onmessage = (event: MessageEvent<ChannelMessage>) => onChannel(event.data);
  broadcast({ kind: 'who' });
  // Load the engine while waiting for the lock, so a takeover only opens the store.
  const sqlite3 = sqlite3InitModule();
  void navigator.locks
    .request(names.lock, { mode: 'exclusive', signal: lockWait.signal }, async () => {
      await lead(store, sqlite3);
      // Hold the lock for this worker's lifetime: it is released when the tab closes the worker.
      return new Promise<never>(() => {});
    })
    .catch((error: unknown) => {
      if (refusal) {
        // This worker withdrew from the lock (retired store or other version) and has said why.
        return;
      }
      const failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      refusal = {
        error: `The state store is unavailable: ${failure}`,
        errorKind: 'unavailable',
      };
      channel?.close();
      channel = undefined;
      toTab({ error: failure, kind: 'failed' });
      // The lock came here, so the writer any forwarded request went to is gone.
      for (const held of waiting.splice(0)) {
        toTab({ error: refusal, id: held.id, kind: 'reply', ok: false });
      }
      for (const id of forwarded.keys()) {
        toTab({ error: leaderLost(), id, kind: 'reply', ok: false });
      }
      forwarded.clear();
    });
}

/**
 * Runs this worker as one tab's state writer worker, composing `composed`
 * beside the state DB. A host's worker entry calls it once, with the
 * extensions every tab of its build runs.
 */
export function startWebStateWorker(composed: readonly WebStateExtension[] = []): void {
  extensions = composed;
  wireProtocol = webStateWireProtocol(composed.map((extension) => extension.id));
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
}
