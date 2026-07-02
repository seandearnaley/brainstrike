import { randomUUID } from 'node:crypto';
import {
  applyManagedCacheBatch,
  applyTursoManagedCacheBatch,
  type BrainstrikeDbExecutionClient,
  escapePGliteLiveQueryFormatPercents,
  insertChunksAndEnqueueEmbeddingJobs,
  insertTursoChunksAndEnqueueEmbeddingJobs,
  invalidateManagedCacheEntriesByIdentity,
  invalidateTursoManagedCacheEntriesByIdentity,
  markTursoCollectionIndexingStatsDirty,
  parseManagedCacheBatchArgs,
  refreshTursoCollectionIndexingStats,
  TursoEmbeddingSetsRepository,
  TursoFileChunkRepository,
  TursoJobQueue,
} from '@brainstrike/db';
import type {
  DbHostInitResult,
  DbHostLiveStartResult,
  DbHostQueryResult,
  DbHostRequest,
  DbHostRequestEnvelope,
  DbHostResponseEnvelope,
  DbHostSerializedError,
  DbHostToMainMessage,
  DbHostTransactionStartResult,
} from './db-host-protocol';
import {
  closeDatabase,
  getDatabase,
  getDatabaseDiagnostics,
  initializeMainDatabaseWithBootstrapReport,
  resetLocalDatabase,
} from './db-main';
import {
  parseInsertChunksAndEnqueueEmbeddingJobsArgs,
  parseManagedCacheInvalidationsArgs,
} from './db-shared';

type LegacyMutationDatabase = Parameters<typeof applyManagedCacheBatch>[0];

interface ParentPortLike {
  readonly on: (event: 'message', listener: (message: unknown) => void) => void;
  readonly postMessage: (message: DbHostToMainMessage) => void;
}

interface QueryableDatabase {
  readonly exec?: (sql: string, params?: readonly unknown[]) => Promise<void>;
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
  readonly transaction: <TResult>(
    callback: (tx: {
      readonly exec: (sql: string, params?: readonly unknown[]) => Promise<void>;
      readonly query: <TRecord = unknown>(
        sql: string,
        params?: readonly unknown[]
      ) => Promise<DbHostQueryResult<TRecord>>;
    }) => Promise<TResult>
  ) => Promise<TResult>;
}

interface QueryableDatabaseContext {
  readonly db: QueryableDatabase;
  readonly engine: 'pglite' | 'turso';
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

let activeTransactionId: string | null = null;
let draining = false;
let pendingRequestSequence = 0;
const pendingControlRequests: QueuedRequest[] = [];
const pendingGeneralRequests: QueuedRequest[] = [];
const pendingTransactionRequests: QueuedRequest[] = [];
const liveQueries = new Map<string, LiveQueryRecord>();
const SLOW_REQUEST_WARNING_MS = 5000;
const EMBEDDINGS_QUEUE = 'embeddings';

function createLiveId(): string {
  return `live:${randomUUID()}`;
}

function serializeError(error: unknown): DbHostSerializedError {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (error instanceof Error) {
    return {
      message: error.message,
      ...(typeof code === 'string' ? { code } : {}),
      ...(error.name ? { name: error.name } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return {
    message: String(error ?? 'unknown error'),
    ...(typeof code === 'string' ? { code } : {}),
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
        sqlPreview: createQueryPreview(request.sql),
        paramsCount: getParamsCount(request.params),
      };
    case 'transaction:query':
    case 'transaction:exec':
      return {
        ...base,
        transactionId: request.transactionId,
        sqlPreview: createQueryPreview(request.sql),
        paramsCount: getParamsCount(request.params),
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
        payloadQueryPreview: createQueryPreview(request.payload.query),
        paramsCount: getParamsCount(request.payload.params),
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
  return (await getQueryableDatabaseContext()).db;
}

async function getQueryableDatabaseContext(): Promise<QueryableDatabaseContext> {
  const initResult = await initializeMainDatabaseWithBootstrapReport();
  if (!initResult.initialized) {
    throw new Error(`DB host bootstrap blocked during ${initResult.bootstrapReport.phase}.`);
  }
  return {
    db: (await getDatabase()) as QueryableDatabase,
    engine: normalizeDbHostRuntimeEngine(initResult.bootstrapReport.runtime.engine),
  };
}

function normalizeDbHostRuntimeEngine(engine: string): QueryableDatabaseContext['engine'] {
  if (engine === 'pglite' || engine === 'turso') {
    return engine;
  }
  throw new Error(`DB host cannot run data mutations for unsupported runtime engine: ${engine}`);
}

function requireDbHostExecutionClient(
  db: QueryableDatabase,
  engine: QueryableDatabaseContext['engine']
): BrainstrikeDbExecutionClient {
  if (typeof db.exec !== 'function' || typeof db.transaction !== 'function') {
    throw new Error(`DB host ${engine} mutations require exec and transaction support.`);
  }
  return db as BrainstrikeDbExecutionClient;
}

function requireTursoExecutionClient(
  db: QueryableDatabase,
  engine: QueryableDatabaseContext['engine']
): BrainstrikeDbExecutionClient {
  if (engine !== 'turso') {
    throw new Error('Turso DB-host owner request requires Turso runtime.');
  }
  return requireDbHostExecutionClient(db, engine);
}

function asLegacyMutationDatabase(db: BrainstrikeDbExecutionClient): LegacyMutationDatabase {
  return db as unknown as LegacyMutationDatabase;
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

function throwUnknownRequestKind(request: never): never {
  const kind =
    request && typeof request === 'object' && 'kind' in request
      ? (request as { readonly kind?: unknown }).kind
      : 'unknown';
  throw new Error(`Unknown DB host request kind: ${String(kind)}`);
}

async function createDbHostInitResult(): Promise<DbHostInitResult> {
  const initResult = await initializeMainDatabaseWithBootstrapReport();

  if (!initResult.bootstrapReport.ready) {
    postLog('error', 'DB host bootstrap capability probe blocked init', {
      phase: initResult.bootstrapReport.phase,
    });
  }

  return initResult;
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
          query,
          params: params ?? null,
          key: request.payload.key ?? '',
          ...(request.payload.offset === undefined ? {} : { offset: request.payload.offset }),
          ...(request.payload.limit === undefined ? {} : { limit: request.payload.limit }),
        })
      : await db.live.query?.({
          query,
          params: params ?? null,
          ...(request.payload.offset === undefined ? {} : { offset: request.payload.offset }),
          ...(request.payload.limit === undefined ? {} : { limit: request.payload.limit }),
        });
  if (!handle) {
    throw new Error('PGlite live query method is unavailable in DB host.');
  }
  handle.subscribe(listener);
  liveQueries.set(liveId, { handle, listener });
  const result: DbHostLiveStartResult = {
    liveId,
    initialResults: handle.initialResults,
  };
  return result;
}

async function handleManagedCacheApplyBatch(
  request: Extract<DbHostRequest, { kind: 'managed-cache:apply-batch' }>
): Promise<{ readonly applied: true }> {
  const { db, engine } = await getQueryableDatabaseContext();
  const args = parseManagedCacheBatchArgs(request.payload);
  const executionDb = requireDbHostExecutionClient(db, engine);
  if (engine === 'turso') {
    await applyTursoManagedCacheBatch(executionDb, args);
  } else {
    await applyManagedCacheBatch(asLegacyMutationDatabase(executionDb), args);
  }
  return { applied: true };
}

async function handleManagedCacheInvalidateByIdentity(
  request: Extract<DbHostRequest, { kind: 'managed-cache:invalidate-by-identity' }>
) {
  const { db, engine } = await getQueryableDatabaseContext();
  const args = parseManagedCacheInvalidationsArgs(request.payload);
  const executionDb = requireDbHostExecutionClient(db, engine);
  if (engine === 'turso') {
    return await invalidateTursoManagedCacheEntriesByIdentity(executionDb, args);
  }
  return await invalidateManagedCacheEntriesByIdentity(asLegacyMutationDatabase(executionDb), args);
}

async function handleChunksInsertAndEnqueueEmbeddingJobs(
  request: Extract<DbHostRequest, { kind: 'chunks:insert-and-enqueue-embedding-jobs' }>
): Promise<{ readonly inserted: true }> {
  const { db, engine } = await getQueryableDatabaseContext();
  const args = parseInsertChunksAndEnqueueEmbeddingJobsArgs(request.payload);
  const executionDb = requireDbHostExecutionClient(db, engine);
  if (engine === 'turso') {
    await insertTursoChunksAndEnqueueEmbeddingJobs(executionDb, args);
  } else {
    await insertChunksAndEnqueueEmbeddingJobs(asLegacyMutationDatabase(executionDb), args);
  }
  return { inserted: true };
}

async function handleTursoEmbeddingWorkerQueueOperation(
  request: Extract<DbHostRequest, { kind: 'turso:embedding-worker:queue' }>
): Promise<unknown> {
  const { db, engine } = await getQueryableDatabaseContext();
  const executionDb = requireTursoExecutionClient(db, engine);
  const queue = new TursoJobQueue(executionDb);
  switch (request.payload.operation) {
    case 'claimMany':
      return await queue.claimMany(request.payload.payload);
    case 'completeBatch':
      return await queue.completeBatch([...request.payload.payload]);
    case 'completeEmbeddingChunkBatch':
      return await queue.completeEmbeddingChunkBatch([...request.payload.payload]);
    case 'fail':
      return await queue.fail(request.payload.payload);
    case 'failBatch':
      return await queue.failBatch(request.payload.payload);
    case 'heartbeatBatch':
      return await queue.heartbeatBatch(
        [...request.payload.payload.jobs],
        request.payload.payload.extendMs
      );
    default:
      return assertNeverTursoEmbeddingWorkerQueueOperation(request.payload);
  }
}

function assertNeverTursoEmbeddingWorkerQueueOperation(_request: never): never {
  throw new Error('Unsupported Turso embedding worker queue operation.');
}

async function handleTursoEmbeddingWorkerStatsOperation(
  request: Extract<DbHostRequest, { kind: 'turso:embedding-worker:stats' }>
): Promise<void> {
  const { db, engine } = await getQueryableDatabaseContext();
  const executionDb = requireTursoExecutionClient(db, engine);
  switch (request.payload.operation) {
    case 'markDirty':
      await markTursoCollectionIndexingStatsDirty(executionDb, request.payload.embeddingSetIds);
      return;
    case 'refresh':
      await executionDb.transaction(async (tx) => {
        await refreshTursoCollectionIndexingStats(tx, request.payload.embeddingSetIds);
      });
      return;
    default:
      return assertNeverTursoEmbeddingWorkerStatsOperation(request.payload.operation);
  }
}

function assertNeverTursoEmbeddingWorkerStatsOperation(_operation: never): never {
  throw new Error('Unsupported Turso embedding worker stats operation.');
}

async function handleTursoVectorQueueAction(
  request: Extract<DbHostRequest, { kind: 'turso:vector-queue:action' }>
): Promise<unknown> {
  const { db, engine } = await getQueryableDatabaseContext();
  const executionDb = requireTursoExecutionClient(db, engine);
  switch (request.payload.operation) {
    case 'clearEmbeddingsForSet': {
      const chunkRepository = new TursoFileChunkRepository(executionDb);
      return {
        cleared: await chunkRepository.clearEmbeddingsForSet(
          request.payload.payload.embeddingSetId
        ),
      };
    }
    case 'clearQueue': {
      const queue = new TursoJobQueue(executionDb);
      return {
        cleared: await queue.clear(
          EMBEDDINGS_QUEUE,
          request.payload.payload.states ? [...request.payload.payload.states] : undefined
        ),
      };
    }
    case 'retryFailed': {
      const queue = new TursoJobQueue(executionDb);
      return await queue.retryFailed(EMBEDDINGS_QUEUE, request.payload.payload.limit);
    }
    case 'wipeQueue': {
      const queue = new TursoJobQueue(executionDb);
      return { cleared: await queue.clear(EMBEDDINGS_QUEUE) };
    }
    default:
      return assertNeverTursoVectorQueueAction(request.payload);
  }
}

function assertNeverTursoVectorQueueAction(_request: never): never {
  throw new Error('Unsupported Turso vector queue action operation.');
}

async function handleTursoEmbeddingBackfillOperation(
  request: Extract<DbHostRequest, { kind: 'turso:embedding-backfill' }>
): Promise<unknown> {
  const { db, engine } = await getQueryableDatabaseContext();
  const executionDb = requireTursoExecutionClient(db, engine);
  switch (request.payload.operation) {
    case 'embeddingSet:getById': {
      const embeddingSetsRepository = new TursoEmbeddingSetsRepository(executionDb);
      return await embeddingSetsRepository.getById(request.payload.embeddingSetId);
    }
    case 'chunk:countEmbeddingBackfillCandidates': {
      const chunkRepository = new TursoFileChunkRepository(executionDb);
      return await chunkRepository.countEmbeddingBackfillCandidates(
        request.payload.embeddingSetId,
        request.payload.queue === undefined ? undefined : { queue: request.payload.queue }
      );
    }
    case 'chunk:findEmbeddingBackfillCandidates': {
      const chunkRepository = new TursoFileChunkRepository(executionDb);
      return await chunkRepository.findEmbeddingBackfillCandidates({
        embeddingSetId: request.payload.embeddingSetId,
        limit: request.payload.limit,
        ...(request.payload.afterChunkId === undefined
          ? {}
          : { afterChunkId: request.payload.afterChunkId }),
        ...(request.payload.queue === undefined ? {} : { queue: request.payload.queue }),
      });
    }
    case 'queue:enqueueBatch': {
      const queue = new TursoJobQueue(executionDb);
      return await queue.enqueueBatch([...request.payload.payload]);
    }
    case 'queue:getEmbeddingSetQueueCounts': {
      const queue = new TursoJobQueue(executionDb);
      return await queue.getEmbeddingSetQueueCounts(
        request.payload.queue,
        request.payload.embeddingSetId,
        request.payload.updatedAfter === undefined
          ? undefined
          : { updatedAfter: request.payload.updatedAfter }
      );
    }
    case 'queue:getQueueStats': {
      const queue = new TursoJobQueue(executionDb);
      return await queue.getQueueStats(request.payload.queue);
    }
    case 'queue:repairUnclaimableQueued': {
      const queue = new TursoJobQueue(executionDb);
      return await queue.repairUnclaimableQueued(request.payload.queue, request.payload.limit, {
        embeddingSetId: request.payload.embeddingSetId,
      });
    }
    default:
      return assertNeverTursoEmbeddingBackfillOperation(request.payload);
  }
}

function assertNeverTursoEmbeddingBackfillOperation(_request: never): never {
  throw new Error('Unsupported Turso embedding backfill operation.');
}

async function handleRequest(request: DbHostRequest): Promise<unknown> {
  switch (request.kind) {
    case 'init': {
      postLog('debug', 'DB host init started');
      const initResult = await createDbHostInitResult();
      postLog('info', initResult.initialized ? 'DB host init completed' : 'DB host init blocked');
      return initResult;
    }
    case 'query': {
      const db = await getQueryableDatabase();
      const params = requireParamsArray(request.params, 'query');
      return params === undefined
        ? await db.query(request.sql)
        : await db.query(request.sql, params);
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
      return params === undefined
        ? await db.query(request.sql)
        : await db.query(request.sql, params);
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
    case 'managed-cache:apply-batch':
      return await handleManagedCacheApplyBatch(request);
    case 'managed-cache:invalidate-by-identity':
      return await handleManagedCacheInvalidateByIdentity(request);
    case 'chunks:insert-and-enqueue-embedding-jobs':
      return await handleChunksInsertAndEnqueueEmbeddingJobs(request);
    case 'turso:embedding-worker:queue':
      return await handleTursoEmbeddingWorkerQueueOperation(request);
    case 'turso:embedding-worker:stats':
      return await handleTursoEmbeddingWorkerStatsOperation(request);
    case 'turso:vector-queue:action':
      return await handleTursoVectorQueueAction(request);
    case 'turso:embedding-backfill':
      return await handleTursoEmbeddingBackfillOperation(request);
    case 'diagnostics':
      return getDatabaseDiagnostics();
    case 'reset':
      await resetLocalDatabase();
      activeTransactionId = null;
      return { reset: true };
    case 'close':
      await closeDatabase();
      activeTransactionId = null;
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
    const result = await handleRequest(envelope.request);
    postResponse(envelope.id, result);
  } catch (error) {
    const serializedError = serializeError(error);
    postLog('error', 'DB host request failed', {
      ...requestDiagnostics,
      ...getQueuedRequestCounts(),
      durationMs: Math.max(0, Date.now() - startedAt),
      error: {
        ...(serializedError.code ? { code: serializedError.code } : {}),
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
  if (draining) {
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
  void handleEnvelope(envelope).finally(() => {
    draining = false;
    drainQueue();
  });
}

parentPort.on('message', (message: unknown) => {
  const envelope = unwrapParentPortMessage(message);
  if (!isEnvelope(envelope)) {
    postError('unknown', new Error('Malformed DB host request envelope.'));
    return;
  }
  enqueueRequest(envelope);
  drainQueue();
});
