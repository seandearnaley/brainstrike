import {
  applyManagedCacheBatch,
  escapePGliteLiveQueryFormatPercents,
  parseManagedCacheBatchArgs,
} from '@brainstrike/db';
import type {
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
  initializeMainDatabase,
  resetLocalDatabase,
} from './db-main';

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

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike | null }).parentPort;

if (!parentPort) {
  throw new Error('DB host entry requires Electron utility process parentPort.');
}

let activeTransactionId: string | null = null;
let activeTransactionSequence = 0;
let draining = false;
const pendingRequests: DbHostRequestEnvelope[] = [];
const liveQueries = new Map<string, LiveQueryRecord>();

function createTransactionId(): string {
  activeTransactionSequence += 1;
  return `tx:${Date.now().toString(36)}:${activeTransactionSequence.toString(36)}`;
}

function createLiveId(): string {
  return `live:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
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

function isTransactionRequestForActiveTransaction(request: DbHostRequest): boolean {
  if (activeTransactionId === null) {
    return true;
  }
  if (
    request.kind === 'transaction:query' ||
    request.kind === 'transaction:exec' ||
    request.kind === 'transaction:commit' ||
    request.kind === 'transaction:rollback'
  ) {
    return request.transactionId === activeTransactionId;
  }
  return request.kind === 'diagnostics';
}

function nextRunnableRequestIndex(): number {
  return pendingRequests.findIndex(({ request }) =>
    isTransactionRequestForActiveTransaction(request)
  );
}

async function getQueryableDatabase(): Promise<QueryableDatabase> {
  return (await getDatabase()) as QueryableDatabase;
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

async function handleRequest(request: DbHostRequest): Promise<unknown> {
  switch (request.kind) {
    case 'init':
      await initializeMainDatabase();
      return { initialized: true };
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
    case 'transaction:start': {
      if (activeTransactionId !== null) {
        throw new Error(`DB transaction already active: ${activeTransactionId}`);
      }
      const db = await getQueryableDatabase();
      await execSql(db, 'BEGIN');
      activeTransactionId = createTransactionId();
      const result: DbHostTransactionStartResult = { transactionId: activeTransactionId };
      return result;
    }
    case 'transaction:query': {
      const db = await getQueryableDatabase();
      const params = requireParamsArray(request.params, 'transaction query');
      return params === undefined
        ? await db.query(request.sql)
        : await db.query(request.sql, params);
    }
    case 'transaction:exec': {
      const db = await getQueryableDatabase();
      return await execSql(db, request.sql, requireParamsArray(request.params, 'transaction exec'));
    }
    case 'transaction:commit': {
      const db = await getQueryableDatabase();
      await execSql(db, 'COMMIT');
      activeTransactionId = null;
      return { committed: true };
    }
    case 'transaction:rollback': {
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
    case 'diagnostics':
      return getDatabaseDiagnostics();
    case 'reset':
      await resetLocalDatabase();
      return { reset: true };
    case 'close':
      await closeDatabase();
      return { closed: true };
  }
}

async function handleEnvelope(envelope: DbHostRequestEnvelope): Promise<void> {
  try {
    const result = await handleRequest(envelope.request);
    postResponse(envelope.id, result);
  } catch (error) {
    if (
      activeTransactionId !== null &&
      (envelope.request.kind === 'transaction:commit' ||
        envelope.request.kind === 'transaction:rollback')
    ) {
      activeTransactionId = null;
    }
    postError(envelope.id, error);
  }
}

function drainQueue(): void {
  if (draining) {
    return;
  }
  const nextIndex = nextRunnableRequestIndex();
  if (nextIndex < 0) {
    return;
  }
  const [envelope] = pendingRequests.splice(nextIndex, 1);
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
  pendingRequests.push(envelope);
  drainQueue();
});
