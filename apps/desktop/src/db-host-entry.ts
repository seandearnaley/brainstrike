import { randomUUID } from 'node:crypto';
import {
  applyManagedCacheBatch,
  escapePGliteLiveQueryFormatPercents,
  insertChunksAndEnqueueEmbeddingJobs,
  invalidateManagedCacheEntriesByIdentity,
  parseManagedCacheBatchArgs,
} from '@brainstrike/db';
import type { DatabaseInitPhaseReport } from '@brainstrike/types';
import {
  DB_HOST_CLOSE_SIGNALS,
  DB_HOST_ERROR_IDENTIFIER_FIELDS,
  type DbHostCloseReason,
  type DbHostLiveStartResult,
  type DbHostQueryResult,
  type DbHostRequest,
  type DbHostRequestEnvelope,
  type DbHostResponseEnvelope,
  type DbHostSerializedError,
  type DbHostSignal,
  type DbHostToMainMessage,
  type DbHostTransactionStartResult,
} from './db-host-protocol';
import {
  closeDatabase,
  getDatabase,
  getDatabaseDiagnostics,
  initializeMainDatabase,
  resetLocalDatabase,
} from './db-main';
import {
  parseInsertChunksAndEnqueueEmbeddingJobsArgs,
  parseManagedCacheInvalidationsArgs,
} from './db-shared';

interface ParentPortLike {
  readonly on: (event: 'message', listener: (message: unknown) => void) => void;
  readonly postMessage: (message: DbHostToMainMessage) => void;
}

interface QueryableDatabase {
  readonly exec?: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
  readonly live?: {
    readonly incrementalQuery?: (payload: {
      readonly key: string;
      readonly limit?: number;
      readonly offset?: number;
      readonly params?: readonly unknown[] | null;
      readonly query: string;
    }) => Promise<LiveQueryHandle>;
    readonly query?: (payload: {
      readonly limit?: number;
      readonly offset?: number;
      readonly params?: readonly unknown[] | null;
      readonly query: string;
    }) => Promise<LiveQueryHandle>;
  };
  readonly query: <TRecord = unknown>(
    sql: string,
    params?: readonly unknown[]
  ) => Promise<DbHostQueryResult<TRecord>>;
}

interface LiveQueryHandle {
  readonly initialResults: DbHostQueryResult;
  readonly refresh: (options?: {
    readonly limit?: number;
    readonly offset?: number;
  }) => Promise<void>;
  readonly subscribe: (listener: (results: DbHostQueryResult) => void) => void;
  readonly unsubscribe: (listener: (results: DbHostQueryResult) => void) => Promise<void>;
}

interface LiveQueryRecord {
  readonly handle: LiveQueryHandle;
  readonly listener: (results: DbHostQueryResult) => void;
}

interface QueuedRequest {
  readonly envelope: DbHostRequestEnvelope;
  readonly sequence: number;
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike | null }).parentPort;

if (!parentPort) {
  throw new Error('DB host entry requires Electron utility process parentPort.');
}

/**
 * `serving` until the first close begins; then `closing` -> `closed` or `close-failed`. A host
 * that is not serving starts nothing: it answers diagnostics, joins a close, and rejects the rest.
 */
type HostLifecycle = 'serving' | 'closing' | 'closed' | 'close-failed';
type ClosePhase = Exclude<HostLifecycle, 'serving'>;

let activeTransactionId: string | null = null;
let closePromise: Promise<void> | null = null;
let closeReason: DbHostCloseReason = 'request';
let draining = false;
let exitAfterClose = false;
// The envelope being handled, so a signal close can let it finish. Never the close envelope: it
// is the closer itself, and the serial queue means nothing else is in flight while it runs.
let inFlightEnvelope: Promise<void> | null = null;
let lifecycle: HostLifecycle = 'serving';
let pendingRequestSequence = 0;
const pendingControlRequests: QueuedRequest[] = [];
const pendingGeneralRequests: QueuedRequest[] = [];
const pendingTransactionRequests: QueuedRequest[] = [];
const liveQueries = new Map<string, LiveQueryRecord>();
const SLOW_REQUEST_WARNING_MS = 5000;

function createLiveId(): string {
  return `live:${randomUUID()}`;
}

/**
 * BST-1330: the serial envelope queue joins protocol statements against
 * close/reset, but the live extension's internal refresh queries are issued by
 * PGlite itself with no queue entry to await. Unsubscribing every live handle
 * BEFORE deactivating the backend removes the one in-host statement issuer
 * that could otherwise wedge close (the BST-1320 race). allSettled: a handle
 * that fails to unsubscribe must not leave the rest subscribed.
 */
async function unsubscribeAllLiveQueries(): Promise<void> {
  const entries = [...liveQueries.entries()];
  liveQueries.clear();
  const results = await Promise.allSettled(
    entries.map(([, record]) => record.handle.unsubscribe(record.listener))
  );
  for (const [index, result] of results.entries()) {
    if (result.status !== 'rejected') {
      continue;
    }
    const rawMessage =
      result.reason instanceof Error ? result.reason.message : String(result.reason ?? '');
    // Same carve-out as db-ipc's cleanupLiveSubscription: an already-closed
    // PGlite is the benign losing-the-race arm, not a drain failure.
    if (rawMessage.toLowerCase().includes('pglite is closed')) {
      continue;
    }
    // Warn, don't throw: close/reset must still proceed (blocking them keeps
    // the wedge risk AND leaves the database open), but a failed unsubscribe
    // means the drain guarantee did not hold for this handle — say so loudly
    // instead of letting allSettled swallow it (NO SILENT FALLBACKS).
    postLog('warn', 'Live query unsubscribe failed during close/reset drain', {
      error: rawMessage,
      liveId: entries[index]?.[0],
    });
  }
}

// SQLSTATE plus the identifier-only Postgres fields. Never `detail`, `where`,
// `hint`, `internalQuery` or `position`: they can carry row data or SQL text.
type PostgresErrorFields = Partial<
  Record<'code' | (typeof DB_HOST_ERROR_IDENTIFIER_FIELDS)[number], string>
>;

function readPostgresErrorFields(error: unknown): PostgresErrorFields {
  if (typeof error !== 'object' || error === null) {
    return {};
  }
  const source = error as Record<string, unknown>;
  const fields: PostgresErrorFields = {};
  for (const field of ['code', ...DB_HOST_ERROR_IDENTIFIER_FIELDS] as const) {
    const value = source[field];
    if (typeof value === 'string') {
      fields[field] = value;
    }
  }
  return fields;
}

function serializeError(error: unknown): DbHostSerializedError {
  const postgresFields = readPostgresErrorFields(error);
  if (error instanceof Error) {
    return {
      message: error.message,
      ...postgresFields,
      ...(error.name ? { name: error.name } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return {
    message: String(error ?? 'unknown error'),
    ...postgresFields,
  };
}

function post(message: DbHostToMainMessage): void {
  parentPort.postMessage(message);
}

function postLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  context: Record<string, unknown> = {}
): void {
  post({
    context: {
      ...context,
      logSource: 'db-host',
      pid: process.pid,
      runtime: 'db-host',
    },
    kind: 'log',
    level,
    message,
  });
}

postLog('info', 'DB host process started');

function createQueryPreview(query: string): string {
  return query.replace(/\s+/g, ' ').slice(0, 240);
}

function getParamsCount(params: readonly unknown[] | null | undefined): number | undefined {
  return params === undefined || params === null ? undefined : params.length;
}

function summarizeRequestForDiagnostics(envelope: DbHostRequestEnvelope): Record<string, unknown> {
  const { request } = envelope;
  const base: Record<string, unknown> = {
    requestId: envelope.id,
    requestKind: request.kind,
  };

  switch (request.kind) {
    case 'query':
    case 'exec':
    case 'maintenance:exec':
      return {
        ...base,
        paramsCount: getParamsCount(request.params),
        sqlPreview: createQueryPreview(request.sql),
      };
    case 'transaction:query':
    case 'transaction:exec':
      return {
        ...base,
        paramsCount: getParamsCount(request.params),
        sqlPreview: createQueryPreview(request.sql),
        transactionId: request.transactionId,
      };
    case 'transaction:commit':
    case 'transaction:rollback':
    case 'transaction:start':
      return {
        ...base,
        transactionId: request.transactionId,
      };
    case 'live:start':
      return {
        ...base,
        paramsCount: getParamsCount(request.payload.params),
        payloadQueryPreview: createQueryPreview(request.payload.query),
      };
    case 'live:refresh':
    case 'live:stop':
      return {
        ...base,
        liveId: request.liveId,
      };
    default:
      return base;
  }
}

function getQueuedRequestCounts(): Record<string, number> {
  return {
    pendingControlRequests: pendingControlRequests.length,
    pendingGeneralRequests: pendingGeneralRequests.length,
    pendingTransactionRequests: pendingTransactionRequests.length,
  };
}

function postResponse(id: string, result: unknown): void {
  const response: DbHostResponseEnvelope = {
    id,
    kind: 'response',
    ok: true,
    result,
  };
  post(response);
}

/**
 * Posted BEFORE a long synchronous phase of `init`: the host answers nothing while it runs one, so
 * this is the only way main can arm that phase's deadline. Needs no timer and no event loop.
 */
function postProgress(id: string, report: DatabaseInitPhaseReport): void {
  post({ id, kind: 'progress', report });
}

function postError(id: string, error: unknown): void {
  const response: DbHostResponseEnvelope = {
    error: serializeError(error),
    id,
    kind: 'response',
    ok: false,
  };
  post(response);
}

function isEnvelope(value: unknown): value is DbHostRequestEnvelope {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'request' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    Boolean((value as { request?: unknown }).request)
  );
}

function unwrapParentPortMessage(message: unknown): unknown {
  if (isEnvelope(message)) {
    return message;
  }
  if (message === null || typeof message !== 'object' || !('data' in message)) {
    return message;
  }
  return (message as { readonly data?: unknown }).data;
}

function isControlRequest(request: DbHostRequest): boolean {
  return request.kind === 'diagnostics' || request.kind === 'reset' || request.kind === 'close';
}

function isTransactionContinuationRequest(request: DbHostRequest): request is Extract<
  DbHostRequest,
  {
    kind: 'transaction:commit' | 'transaction:exec' | 'transaction:query' | 'transaction:rollback';
  }
> {
  return (
    request.kind === 'transaction:query' ||
    request.kind === 'transaction:exec' ||
    request.kind === 'transaction:commit' ||
    request.kind === 'transaction:rollback'
  );
}

function assertActiveTransaction(request: DbHostRequest): void {
  if (!isTransactionContinuationRequest(request)) {
    return;
  }
  if (activeTransactionId === null) {
    throw new Error(`No DB transaction is active for request: ${request.kind}`);
  }
  if (request.transactionId !== activeTransactionId) {
    throw new Error(
      `DB transaction mismatch: active ${activeTransactionId}, received ${request.transactionId}`
    );
  }
}

function enqueueRequest(envelope: DbHostRequestEnvelope): void {
  const queuedRequest: QueuedRequest = {
    envelope,
    sequence: pendingRequestSequence,
  };
  pendingRequestSequence += 1;
  if (isControlRequest(envelope.request)) {
    pendingControlRequests.push(queuedRequest);
    return;
  }
  if (isTransactionContinuationRequest(envelope.request)) {
    pendingTransactionRequests.push(queuedRequest);
    return;
  }
  pendingGeneralRequests.push(queuedRequest);
}

function shiftEarliestRequest(queues: readonly QueuedRequest[][]): DbHostRequestEnvelope | null {
  let selectedQueue: QueuedRequest[] | null = null;
  let selectedRequest: QueuedRequest | undefined;
  for (const queue of queues) {
    const head = queue[0];
    if (head && (!selectedRequest || head.sequence < selectedRequest.sequence)) {
      selectedQueue = queue;
      selectedRequest = head;
    }
  }
  return selectedQueue?.shift()?.envelope ?? null;
}

function nextRunnableRequest(): DbHostRequestEnvelope | null {
  if (activeTransactionId !== null) {
    return shiftEarliestRequest([pendingControlRequests, pendingTransactionRequests]);
  }
  if (
    pendingControlRequests.length === 0 &&
    pendingGeneralRequests.length === 0 &&
    pendingTransactionRequests.length === 0
  ) {
    return null;
  }
  return shiftEarliestRequest([
    pendingControlRequests,
    pendingGeneralRequests,
    pendingTransactionRequests,
  ]);
}

async function getQueryableDatabase(): Promise<QueryableDatabase> {
  return await getDatabase();
}

function requireParamsArray(params: unknown, context: string): readonly unknown[] | undefined {
  if (params === undefined) {
    return;
  }
  if (Array.isArray(params)) {
    return params;
  }
  throw new Error(`DB host ${context} params must be an array when provided.`);
}

async function execSql(
  db: QueryableDatabase,
  sql: string,
  params?: readonly unknown[]
): Promise<unknown> {
  if (typeof db.exec === 'function') {
    return params === undefined ? await db.exec(sql) : await db.exec(sql, params);
  }
  return params === undefined ? await db.query(sql) : await db.query(sql, params);
}

async function runHostQuery(
  db: QueryableDatabase,
  sql: string,
  params: readonly unknown[] | undefined
): Promise<DbHostQueryResult<unknown>> {
  return params === undefined ? await db.query(sql) : await db.query(sql, params);
}

function throwUnknownRequestKind(request: never): never {
  const kind =
    request && typeof request === 'object' && 'kind' in request
      ? (request as { readonly kind?: unknown }).kind
      : 'unknown';
  throw new Error(`Unknown DB host request kind: ${String(kind)}`);
}

async function handleLiveStart(request: Extract<DbHostRequest, { kind: 'live:start' }>) {
  const db = await getQueryableDatabase();
  if (!db.live) {
    throw new Error('PGlite live extension is unavailable in DB host.');
  }
  const liveId = createLiveId();
  const listener = (results: DbHostQueryResult) => {
    post({ kind: 'live-update', liveId, results });
  };
  const params = requireParamsArray(request.payload.params, 'live query');
  const query = escapePGliteLiveQueryFormatPercents(request.payload.query, params);
  const handle =
    request.payload.mode === 'incremental'
      ? await db.live.incrementalQuery?.({
          key: request.payload.key ?? '',
          params: params ?? null,
          query,
          ...(request.payload.offset === undefined ? {} : { offset: request.payload.offset }),
          ...(request.payload.limit === undefined ? {} : { limit: request.payload.limit }),
        })
      : await db.live.query?.({
          params: params ?? null,
          query,
          ...(request.payload.offset === undefined ? {} : { offset: request.payload.offset }),
          ...(request.payload.limit === undefined ? {} : { limit: request.payload.limit }),
        });
  if (!handle) {
    throw new Error('PGlite live query method is unavailable in DB host.');
  }
  handle.subscribe(listener);
  liveQueries.set(liveId, { handle, listener });
  const result: DbHostLiveStartResult = {
    initialResults: handle.initialResults,
    liveId,
  };
  return result;
}

function describeDiagnostics(): unknown {
  return {
    ...getDatabaseDiagnostics(),
    activeLiveQueryCount: liveQueries.size,
  };
}

async function handleRequest(request: DbHostRequest, requestId: string): Promise<unknown> {
  switch (request.kind) {
    case 'init':
      postLog('debug', 'DB host init started');
      await initializeMainDatabase({ onPhase: (report) => postProgress(requestId, report) });
      postLog('info', 'DB host init completed');
      return { initialized: true };
    case 'query': {
      const db = await getQueryableDatabase();
      const params = requireParamsArray(request.params, 'query');
      return await runHostQuery(db, request.sql, params);
    }
    case 'exec': {
      const db = await getQueryableDatabase();
      return await execSql(db, request.sql, requireParamsArray(request.params, 'exec'));
    }
    case 'maintenance:exec': {
      const db = await getQueryableDatabase();
      return await execSql(db, request.sql, requireParamsArray(request.params, 'maintenance exec'));
    }
    case 'transaction:start': {
      if (activeTransactionId !== null) {
        throw new Error(`DB transaction already active: ${activeTransactionId}`);
      }
      const db = await getQueryableDatabase();
      await execSql(db, 'BEGIN');
      activeTransactionId = request.transactionId;
      const result: DbHostTransactionStartResult = { transactionId: activeTransactionId };
      return result;
    }
    case 'transaction:query': {
      assertActiveTransaction(request);
      const db = await getQueryableDatabase();
      const params = requireParamsArray(request.params, 'transaction query');
      return await runHostQuery(db, request.sql, params);
    }
    case 'transaction:exec': {
      assertActiveTransaction(request);
      const db = await getQueryableDatabase();
      return await execSql(db, request.sql, requireParamsArray(request.params, 'transaction exec'));
    }
    case 'transaction:commit': {
      assertActiveTransaction(request);
      const db = await getQueryableDatabase();
      await execSql(db, 'COMMIT');
      activeTransactionId = null;
      return { committed: true };
    }
    case 'transaction:rollback': {
      assertActiveTransaction(request);
      const db = await getQueryableDatabase();
      await execSql(db, 'ROLLBACK');
      activeTransactionId = null;
      return { rolledBack: true };
    }
    case 'live:start':
      return await handleLiveStart(request);
    case 'live:refresh': {
      const record = liveQueries.get(request.liveId);
      if (!record) {
        throw new Error(`Live query not found: ${request.liveId}`);
      }
      await record.handle.refresh({
        ...(request.offset === undefined ? {} : { offset: request.offset }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      });
      return { refreshed: true };
    }
    case 'live:stop': {
      const record = liveQueries.get(request.liveId);
      if (record) {
        liveQueries.delete(request.liveId);
        await record.handle.unsubscribe(record.listener);
      }
      return { stopped: true };
    }
    case 'managed-cache:apply-batch': {
      const db = await getQueryableDatabase();
      await applyManagedCacheBatch(db, parseManagedCacheBatchArgs(request.payload));
      return { applied: true };
    }
    case 'managed-cache:invalidate-by-identity': {
      const db = await getQueryableDatabase();
      return await invalidateManagedCacheEntriesByIdentity(
        db,
        parseManagedCacheInvalidationsArgs(request.payload)
      );
    }
    case 'chunks:insert-and-enqueue-embedding-jobs': {
      const db = await getQueryableDatabase();
      await insertChunksAndEnqueueEmbeddingJobs(
        db,
        parseInsertChunksAndEnqueueEmbeddingJobsArgs(request.payload)
      );
      return { inserted: true };
    }
    case 'diagnostics':
      return describeDiagnostics();
    case 'reset':
      await unsubscribeAllLiveQueries();
      await resetLocalDatabase();
      activeTransactionId = null;
      return { reset: true };
    case 'close':
      await beginClose('request');
      return { closed: true };
    default:
      return throwUnknownRequestKind(request);
  }
}

async function handleEnvelope(envelope: DbHostRequestEnvelope): Promise<void> {
  const startedAt = Date.now();
  const requestDiagnostics = summarizeRequestForDiagnostics(envelope);
  const slowRequestTimer = setTimeout(() => {
    postLog('warn', 'DB host request still running', {
      ...requestDiagnostics,
      ...getQueuedRequestCounts(),
      activeDurationMs: Math.max(0, Date.now() - startedAt),
    });
  }, SLOW_REQUEST_WARNING_MS);

  try {
    const result = await handleRequest(envelope.request, envelope.id);
    postResponse(envelope.id, result);
  } catch (error) {
    const serializedError = serializeError(error);
    postLog('error', 'DB host request failed', {
      ...requestDiagnostics,
      ...getQueuedRequestCounts(),
      durationMs: Math.max(0, Date.now() - startedAt),
      error: {
        ...readPostgresErrorFields(serializedError),
        message: serializedError.message,
        ...(serializedError.name ? { name: serializedError.name } : {}),
      },
      requestKind: envelope.request.kind,
    });
    postError(envelope.id, error);
  } finally {
    clearTimeout(slowRequestTimer);
  }
}

function drainQueue(): void {
  if (draining || lifecycle !== 'serving') {
    return;
  }
  // PGlite runs through a single connection in this host. Serial dispatch keeps live-query,
  // transaction, and reset ordering deterministic; foreground/background fairness happens
  // in the main-process scheduler before requests reach this utility process.
  const envelope = nextRunnableRequest();
  if (!envelope) {
    return;
  }
  draining = true;
  const running = handleEnvelope(envelope).finally(() => {
    draining = false;
    inFlightEnvelope = null;
    drainQueue();
  });
  inFlightEnvelope = envelope.request.kind === 'close' ? null : running;
}

const NOT_SERVING_TEXT = {
  'close-failed': 'failed to close',
  closed: 'is closed',
  closing: 'is closing',
} as const satisfies Record<ClosePhase, string>;

/** Answers an envelope the host will not serve: diagnostics, a join of the close, or a typed rejection. */
function answerWithoutServing(envelope: DbHostRequestEnvelope, phase: ClosePhase): void {
  const { id, request } = envelope;
  if (request.kind === 'diagnostics') {
    postResponse(id, describeDiagnostics());
    return;
  }
  if (request.kind === 'close') {
    beginClose(closeReason).then(
      () => postResponse(id, { closed: true }),
      (error: unknown) => postError(id, error)
    );
    return;
  }
  postError(id, new Error(`DB host ${NOT_SERVING_TEXT[phase]} (${closeReason}).`));
}

function answerQueuedRequests(phase: ClosePhase): void {
  for (const queue of [
    pendingControlRequests,
    pendingGeneralRequests,
    pendingTransactionRequests,
  ]) {
    for (const { envelope } of queue.splice(0)) {
      answerWithoutServing(envelope, phase);
    }
  }
}

async function closeWhenIdle(settled: Promise<void> | null): Promise<void> {
  try {
    // The statement already running answers its own caller; only the backlog behind it was rejected.
    await settled;
    await unsubscribeAllLiveQueries();
    await closeDatabase();
    activeTransactionId = null;
    lifecycle = 'closed';
    post({ kind: 'lifecycle', reason: closeReason, state: 'closed' });
  } catch (error) {
    lifecycle = 'close-failed';
    postLog('error', 'DB host failed to close the database', {
      error: serializeError(error),
      reason: closeReason,
    });
    post({
      error: serializeError(error),
      kind: 'lifecycle',
      reason: closeReason,
      state: 'close-failed',
    });
    throw error;
  } finally {
    // Exit 0 only after a clean close. The code is informational: main proves a clean close by the
    // acknowledgement or the marker naming this pid, never by the exit code. The exit waits one
    // macrotask so the replies to the in-flight and joined `close` envelopes, posted from promise
    // callbacks that run right after this settles, are queued before it. That orders them; it does
    // not guarantee their delivery, which is why the marker, not a reply, is the proof.
    if (exitAfterClose) {
      const code = lifecycle === 'closed' ? 0 : 1;
      setImmediate(() => process.exit(code));
    }
  }
}

/**
 * Single-flight: the first caller starts the close, every later one joins it. Stops serving at
 * once, rejects the queued backlog, lets the in-flight envelope finish, then closes PGlite
 * through the same `closeDatabase()` a close envelope always used (it writes the
 * clean-shutdown marker before releasing the lock).
 */
function beginClose(reason: DbHostCloseReason): Promise<void> {
  if (closePromise) {
    return closePromise;
  }
  lifecycle = 'closing';
  closeReason = reason;
  post({ kind: 'lifecycle', reason, state: 'closing' });
  closePromise = closeWhenIdle(inFlightEnvelope);
  answerQueuedRequests('closing');
  return closePromise;
}

function onSignal(signal: DbHostSignal): void {
  postLog('warn', `DB host received ${signal}`, { lifecycle });
  if (lifecycle === 'closed' || lifecycle === 'close-failed') {
    // Already over: a signal can neither reopen the database nor turn a failed close clean.
    process.exit(lifecycle === 'closed' ? 0 : 1);
  } else {
    exitAfterClose = true;
    // Not swallowed: `closeWhenIdle` has already logged the failure, announced `close-failed`,
    // and exits 1 itself.
    beginClose(signal).catch(() => undefined);
  }
}

parentPort.on('message', (message: unknown) => {
  const envelope = unwrapParentPortMessage(message);
  if (!isEnvelope(envelope)) {
    postError('unknown', new Error('Malformed DB host request envelope.'));
    return;
  }
  if (lifecycle !== 'serving') {
    answerWithoutServing(envelope, lifecycle);
    return;
  }
  enqueueRequest(envelope);
  drainQueue();
});

// A tree teardown (tty group, concurrently's tree-kill, turbo, OS shutdown) signals every process
// in the tree, this host included, and main reaches its own database step last. Closing here at
// once turns that common unclean path into a clean one. Persistent (`on`, never `once`): the same
// signal arrives repeatedly, and a once-listener would restore the default action after the first.
for (const signal of DB_HOST_CLOSE_SIGNALS) {
  process.on(signal, () => {
    onSignal(signal);
  });
}
