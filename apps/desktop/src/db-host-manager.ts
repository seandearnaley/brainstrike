import { randomUUID } from 'node:crypto';
import { createLogger } from '@brainstrike/logging';
import { type UtilityProcess, utilityProcess } from 'electron';
import { resolveBundledSiblingPath } from './bundled-sibling-path';
import {
  DB_HOST_ERROR_IDENTIFIER_FIELDS,
  type DbHostDiagnosticsResult,
  type DbHostInitResult,
  type DbHostLiveQueryDiagnostics,
  type DbHostLiveStartResult,
  type DbHostManagerDiagnosticsResult,
  type DbHostQueryResult,
  type DbHostRequest,
  type DbHostRequestEnvelope,
  type DbHostResponseEnvelope,
  type DbHostRowMode,
  type DbHostSerializedError,
  type DbHostToMainMessage,
  type DbHostTransactionStartResult,
} from './db-host-protocol';
import { DbHostRequestTimeoutError } from './db-host-timeout-error';
import { DB_PROFILE_ENV, DB_ROOT_PATH_ENV, SERIALIZE_PGLITE_INIT_ENV } from './db-runtime-env';
import { resolveDesktopDatabaseLocation } from './desktop-database-location';
import {
  createHostRequestChannel,
  type HostRequestChannel,
  type HostRequestTimeoutContext,
  type HostRequestTimeoutDecision,
} from './platform/host-request-channel';

export { DbHostRequestTimeoutError } from './db-host-timeout-error';

const logger = createLogger('DbHostManager');

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 90_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2000;

function createLiveQueryDiagnostics(payload: {
  readonly mode: 'query' | 'incremental';
  readonly params?: readonly unknown[] | null;
  readonly query: string;
}): {
  readonly mode: 'query' | 'incremental';
  readonly paramsCount: number;
  readonly queryPreview: string;
  readonly unescapedPercentRuns: number;
} {
  const queryPreview = payload.query.replace(/\s+/g, ' ').slice(0, 240);
  const percentRuns = payload.query.match(/%+/g) ?? [];
  return {
    mode: payload.mode,
    paramsCount: payload.params?.length ?? 0,
    queryPreview,
    unescapedPercentRuns: percentRuns.filter((run) => run.length % 2 === 1).length,
  };
}

export interface RemoteDbTransaction {
  readonly exec: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
  /**
   * `options.rowMode: 'array'` returns positional rows plus `fields`. Callers
   * that omit it get the default object-keyed rows, unchanged. Array mode
   * exists for the agent SQL sandbox, which must preserve duplicate output
   * column names that object rows collapse.
   */
  readonly query: <TRecord = unknown>(
    sql: string,
    params?: readonly unknown[],
    options?: { readonly rowMode?: DbHostRowMode }
  ) => Promise<DbHostQueryResult<TRecord>>;
}

export interface RemoteDbLiveQuery<TRecord = unknown> {
  readonly initialResults: DbHostQueryResult<TRecord>;
  readonly refresh: (options?: {
    readonly limit?: number;
    readonly offset?: number;
  }) => Promise<void>;
  readonly subscribe: (listener: (results: DbHostQueryResult<TRecord>) => void) => void;
  readonly unsubscribe: (listener?: (results: DbHostQueryResult<TRecord>) => void) => Promise<void>;
}

export interface RemoteDbClient extends RemoteDbTransaction {
  readonly live: {
    readonly incrementalQuery: <TRecord = unknown>(
      payload:
        | {
            readonly key: string;
            readonly limit?: number;
            readonly offset?: number;
            readonly params?: readonly unknown[] | null;
            readonly query: string;
          }
        | string,
      params?: readonly unknown[] | null,
      key?: string
    ) => Promise<RemoteDbLiveQuery<TRecord>>;
    readonly query: <TRecord = unknown>(
      payload:
        | {
            readonly limit?: number;
            readonly offset?: number;
            readonly params?: readonly unknown[] | null;
            readonly query: string;
          }
        | string,
      params?: readonly unknown[] | null
    ) => Promise<RemoteDbLiveQuery<TRecord>>;
  };
  readonly maintenance: {
    readonly exec: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
  };
  readonly transaction: <TResult>(
    fn: (tx: RemoteDbTransaction) => Promise<TResult>
  ) => Promise<TResult>;
}

export interface DbHostManager {
  readonly applyManagedCacheBatch: (payload: unknown) => Promise<void>;
  readonly close: () => Promise<void>;
  readonly getDatabase: () => Promise<RemoteDbClient>;
  readonly getDiagnostics: () => Promise<DbHostManagerDiagnosticsResult>;
  readonly getLiveQueryDiagnosticsForTests: () => Promise<DbHostLiveQueryDiagnostics>;
  readonly insertChunksAndEnqueueEmbeddingJobs: (payload: unknown) => Promise<void>;
  readonly invalidateManagedCacheEntriesByIdentity: (payload: unknown) => Promise<unknown>;
  readonly reset: () => Promise<void>;
}

export interface DbHostManagerOptions {
  readonly closeTimeoutMs?: number;
  readonly entryPath?: string;
  readonly initializationTimeoutMs?: number;
  readonly maintenanceRequestTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

interface RequestTimeoutDiagnostics {
  readonly liveId?: string;
  readonly paramsCount?: number;
  readonly payloadQueryPreview?: string;
  readonly requestKind: DbHostRequest['kind'];
  readonly sqlPreview?: string;
  readonly transactionId?: string;
}

function toError(error: DbHostSerializedError): Error {
  const normalized = new Error(error.message);
  normalized.name = error.name ?? 'DbHostError';
  if (error.stack) {
    normalized.stack = error.stack;
  }
  for (const field of ['code', ...DB_HOST_ERROR_IDENTIFIER_FIELDS] as const) {
    const value = error[field];
    if (value) {
      Object.assign(normalized, { [field]: value });
    }
  }
  return normalized;
}

function createRequestId(): string {
  return `db-host:${randomUUID()}`;
}

function createTransactionId(): string {
  return `tx:${randomUUID()}`;
}

function requiresHostTerminationOnTimeout(request: DbHostRequest): boolean {
  return (
    request.kind === 'transaction:start' ||
    request.kind === 'transaction:query' ||
    request.kind === 'transaction:exec' ||
    request.kind === 'transaction:commit' ||
    request.kind === 'transaction:rollback'
  );
}

function createQueryPreview(query: string): string {
  return query.replace(/\s+/g, ' ').slice(0, 240);
}

function getParamsCount(params: readonly unknown[] | undefined): number | undefined {
  return params === undefined ? undefined : params.length;
}

function createParamsCountDiagnostic(params: readonly unknown[] | undefined): {
  readonly paramsCount?: number;
} {
  const paramsCount = getParamsCount(params);
  return paramsCount === undefined ? {} : { paramsCount };
}

function createRequestTimeoutDiagnostics(request: DbHostRequest): RequestTimeoutDiagnostics {
  switch (request.kind) {
    case 'query':
    case 'exec':
    case 'maintenance:exec':
      return {
        requestKind: request.kind,
        sqlPreview: createQueryPreview(request.sql),
        ...createParamsCountDiagnostic(request.params),
      };
    case 'transaction:query':
    case 'transaction:exec':
      return {
        requestKind: request.kind,
        sqlPreview: createQueryPreview(request.sql),
        transactionId: request.transactionId,
        ...createParamsCountDiagnostic(request.params),
      };
    case 'transaction:commit':
    case 'transaction:rollback':
    case 'transaction:start':
      return {
        requestKind: request.kind,
        transactionId: request.transactionId,
      };
    case 'live:start':
      return {
        payloadQueryPreview: createQueryPreview(request.payload.query),
        requestKind: request.kind,
        ...createParamsCountDiagnostic(request.payload.params),
      };
    case 'live:refresh':
    case 'live:stop':
      return {
        liveId: request.liveId,
        requestKind: request.kind,
      };
    default:
      return { requestKind: request.kind };
  }
}

export function resolveDbHostEntryPath(currentModuleFilename?: string): string {
  return resolveBundledSiblingPath('DB host entry', 'db-host-entry.js', currentModuleFilename);
}

function createDbHostEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  const allowedKeys = ['NODE_ENV', 'LOG_LEVEL'] as const;
  for (const key of allowedKeys) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  const serializePGliteInit = process.env[SERIALIZE_PGLITE_INIT_ENV];
  if (serializePGliteInit !== undefined) {
    environment[SERIALIZE_PGLITE_INIT_ENV] = serializePGliteInit;
  }
  // Main resolves the database location once. The host reads these two
  // variables and derives nothing itself, so a host respawned after a git
  // branch switch still opens the profile main's reset path will delete.
  const location = resolveDesktopDatabaseLocation();
  environment[DB_PROFILE_ENV] = location.profile;
  environment[DB_ROOT_PATH_ENV] = location.rootPath;
  return environment;
}

function isDbHostToMainMessage(value: unknown): value is DbHostToMainMessage {
  return (
    value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    typeof (value as { kind?: unknown }).kind === 'string'
  );
}

class RemoteLiveQuery<TRecord = unknown> implements RemoteDbLiveQuery<TRecord> {
  readonly #listeners = new Set<(results: DbHostQueryResult<TRecord>) => void>();
  readonly #manager: DefaultDbHostManager;
  readonly #liveId: string;
  #failure: Error | null = null;
  #initialResults: DbHostQueryResult<TRecord>;
  #stopped = false;

  constructor(
    manager: DefaultDbHostManager,
    liveId: string,
    initialResults: DbHostQueryResult<TRecord>
  ) {
    this.#manager = manager;
    this.#liveId = liveId;
    this.#initialResults = initialResults;
  }

  get initialResults(): DbHostQueryResult<TRecord> {
    return this.#initialResults;
  }

  subscribe(listener: (results: DbHostQueryResult<TRecord>) => void): void {
    if (this.#stopped) {
      return;
    }
    this.#listeners.add(listener);
  }

  async refresh(options?: { readonly limit?: number; readonly offset?: number }): Promise<void> {
    if (this.#failure) {
      throw this.#failure;
    }
    if (this.#stopped) {
      return;
    }
    const request: DbHostRequest = {
      kind: 'live:refresh',
      liveId: this.#liveId,
      ...(options?.limit === undefined ? {} : { limit: options.limit }),
      ...(options?.offset === undefined ? {} : { offset: options.offset }),
    };
    await this.#manager.send(request);
  }

  async unsubscribe(listener?: (results: DbHostQueryResult<TRecord>) => void): Promise<void> {
    if (listener) {
      this.#listeners.delete(listener);
      if (this.#listeners.size > 0) {
        return;
      }
    }
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#manager.unregisterLiveQuery(this.#liveId);
    if (this.#failure) {
      return;
    }
    await this.#manager.send({ kind: 'live:stop', liveId: this.#liveId });
  }

  acceptUpdate(results: DbHostQueryResult<TRecord>): void {
    if (this.#stopped) {
      return;
    }
    this.#initialResults = results;
    for (const listener of this.#listeners) {
      listener(results);
    }
  }

  fail(error: Error): void {
    this.#failure = error;
    this.#stopped = true;
    this.#listeners.clear();
  }
}

interface AbandonedRequest {
  readonly requestKind: string;
  readonly startedAt: number;
  readonly timedOutAt: number;
  readonly timeoutMs: number;
}

// Bounded memory of requests that timed out client-side while the DB host may
// still be executing them (the host runs one statement at a time; an IPC
// timeout does NOT cancel the statement). A late response for one of these
// must be logged, never dropped silently.
const MAX_ABANDONED_REQUESTS = 64;

class DefaultDbHostManager implements DbHostManager {
  readonly #entryPath: string;
  readonly #liveQueries = new Map<string, RemoteLiveQuery<unknown>>();
  readonly #requests: HostRequestChannel<DbHostRequestEnvelope, DbHostResponseEnvelope>;
  readonly #abandoned = new Map<string, AbandonedRequest>();
  readonly #closeTimeoutMs: number;
  readonly #initializationTimeoutMs: number;
  readonly #maintenanceRequestTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  #retired = false;
  #client: RemoteDbClient | null = null;
  #host: UtilityProcess | null = null;
  #initialization: Promise<RemoteDbClient> | null = null;

  constructor(options: DbHostManagerOptions = {}) {
    this.#entryPath = options.entryPath ?? resolveDbHostEntryPath();
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#maintenanceRequestTimeoutMs =
      options.maintenanceRequestTimeoutMs ?? Math.max(10 * 60_000, this.#requestTimeoutMs);
    this.#initializationTimeoutMs =
      options.initializationTimeoutMs ??
      Math.max(DEFAULT_INITIALIZATION_TIMEOUT_MS, this.#requestTimeoutMs);
    this.#requests = createHostRequestChannel<DbHostRequestEnvelope, DbHostResponseEnvelope>({
      // The DB host owns its own late-response ledger; the channel's default
      // warn would report an id this manager can describe far better.
      onLateResponse: (requestId, response) => {
        this.#logLateResponse(requestId, response);
      },
      onTimeout: (envelope, context) => this.#decideRequestTimeout(envelope, context),
      requestId: (envelope) => envelope.id,
      responseId: (response) => response.id,
      role: 'DB host',
      // `send()` has already forked the host on the statement immediately
      // before this runs, so this resolves to that same process; it can only
      // fork when the host died in between, which is the behaviour a request
      // arriving after an exit already had.
      send: (envelope) => {
        this.#ensureHost().postMessage(envelope);
      },
      timeoutMs: (envelope) => this.#getRequestTimeoutMs(envelope.request),
    });
  }

  async getDatabase(): Promise<RemoteDbClient> {
    this.#assertActive();
    if (this.#client) {
      return this.#client;
    }
    if (this.#initialization) {
      return await this.#initialization;
    }
    this.#initialization = this.#initialize();
    try {
      return await this.#initialization;
    } finally {
      // Concurrent callers have already received the shared promise above. Clearing here
      // allows a later failed/closed host to be initialized again by the next caller.
      this.#initialization = null;
    }
  }

  async getDiagnostics(): Promise<DbHostManagerDiagnosticsResult> {
    const result = await this.send<DbHostDiagnosticsResult>({ kind: 'diagnostics' });
    const { activeLiveQueryCount, ...databaseDiagnostics } = result;
    void activeLiveQueryCount;
    return {
      ...databaseDiagnostics,
      hostPid: this.#host?.pid ?? null,
    };
  }

  async getLiveQueryDiagnosticsForTests(): Promise<DbHostLiveQueryDiagnostics> {
    if (
      !(
        process.argv.includes('--test-mode') ||
        process.env['ELECTRON_IS_E2E_TEST'] === 'true' ||
        process.env['NODE_ENV'] === 'test'
      )
    ) {
      throw new Error('DB host live-query diagnostics are available only in test mode.');
    }
    const result = await this.send<DbHostDiagnosticsResult>({ kind: 'diagnostics' });
    return {
      hostLiveQueryCount: result.activeLiveQueryCount,
      managerLiveQueryCount: this.#liveQueries.size,
    };
  }

  async reset(): Promise<void> {
    await this.send({ kind: 'reset' });
    this.#client = null;
  }

  // Default-manager replacement is permanent; explicit close() remains reusable
  // for reinitializeDatabase(). Retained clients must never fork another owner.
  async retire(): Promise<void> {
    this.#retired = true;
    await this.close();
  }

  #assertActive(): void {
    if (this.#retired) {
      throw new Error('DB host manager is retired.');
    }
  }

  async close(): Promise<void> {
    if (!this.#host) {
      return;
    }
    try {
      await this.#closeHostWithinTimeout();
    } finally {
      this.#rejectAll(new Error('DB host closed.'));
      this.#host.kill();
      this.#host = null;
      this.#client = null;
      this.#failAllLiveQueries(new Error('DB host closed.'));
    }
  }

  async #closeHostWithinTimeout(): Promise<void> {
    const closeRequest = this.send({ kind: 'close' });
    void closeRequest.catch(() => undefined);
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<'timeout'>((resolve) => {
      timeoutId = setTimeout(() => resolve('timeout'), this.#closeTimeoutMs);
    });
    const result = await Promise.race([closeRequest, timeout]);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (result === 'timeout') {
      logger.warn('Timed out waiting for DB host close acknowledgement; terminating host', {
        timeoutMs: this.#closeTimeoutMs,
      });
    }
  }

  async applyManagedCacheBatch(payload: unknown): Promise<void> {
    await this.send({ kind: 'managed-cache:apply-batch', payload });
  }

  async invalidateManagedCacheEntriesByIdentity(payload: unknown): Promise<unknown> {
    return await this.send({ kind: 'managed-cache:invalidate-by-identity', payload });
  }

  async insertChunksAndEnqueueEmbeddingJobs(payload: unknown): Promise<void> {
    await this.send({ kind: 'chunks:insert-and-enqueue-embedding-jobs', payload });
  }

  async send<TResult = unknown>(request: DbHostRequest): Promise<TResult> {
    if (request.kind !== 'close') {
      this.#assertActive();
    }
    this.#ensureHost();
    const envelope: DbHostRequestEnvelope = {
      id: createRequestId(),
      kind: 'request',
      request,
    };
    const response = await this.#requests.request(envelope);
    if (!response.ok) {
      throw toError(response.error);
    }
    return response.result as TResult;
  }

  /**
   * A timed-out request is NOT cancelled: the host runs one statement at a
   * time and an IPC deadline cannot reach into it, so the request joins the
   * abandoned ledger and its eventual late response is logged. Transaction
   * requests are the exception — their connection state cannot survive an
   * abandoned statement, so the host is terminated.
   */
  #decideRequestTimeout(
    envelope: DbHostRequestEnvelope,
    context: HostRequestTimeoutContext
  ): HostRequestTimeoutDecision {
    const { request } = envelope;
    const willTerminateHost = requiresHostTerminationOnTimeout(request);
    const abandonedState = this.#getAbandonedRequestState(context.timedOutAt);
    const error = new DbHostRequestTimeoutError({
      ...abandonedState,
      pendingCount: context.pendingCount,
      requestKind: request.kind,
      timeoutMs: context.timeoutMs,
      willTerminateHost,
    });
    logger.warn(
      {
        ...createRequestTimeoutDiagnostics(request),
        elapsedMs: Math.max(0, Date.now() - context.startedAt),
        ...abandonedState,
        pendingByKind: this.#getPendingRequestCountsByKind(),
        pendingCount: context.pendingCount,
        requestId: envelope.id,
        timeoutMs: context.timeoutMs,
        willTerminateHost,
      },
      'DB host request timed out'
    );
    this.#recordAbandonedRequest(envelope.id, {
      requestKind: request.kind,
      startedAt: context.startedAt,
      timedOutAt: context.timedOutAt,
      timeoutMs: context.timeoutMs,
    });
    if (!willTerminateHost) {
      return { error, policy: 'abandon' };
    }
    return {
      error,
      policy: 'terminate',
      terminate: (terminationError) => {
        this.#terminateHost(terminationError);
      },
    };
  }

  #getPendingRequestCountsByKind(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const envelope of this.#requests.inFlight()) {
      counts[envelope.request.kind] = (counts[envelope.request.kind] ?? 0) + 1;
    }
    return counts;
  }

  #getAbandonedRequestState(now: number): {
    readonly hasStaleAbandonedRequest: boolean;
    readonly recentAbandonedCount: number;
  } {
    let hasStaleAbandonedRequest = false;
    let recentAbandonedCount = 0;
    for (const request of this.#abandoned.values()) {
      if (now - request.timedOutAt < request.timeoutMs) {
        recentAbandonedCount += 1;
      } else {
        hasStaleAbandonedRequest = true;
      }
    }
    return { hasStaleAbandonedRequest, recentAbandonedCount };
  }

  #getRequestTimeoutMs(request: DbHostRequest): number {
    if (request.kind === 'init') {
      return this.#initializationTimeoutMs;
    }
    if (request.kind === 'maintenance:exec') {
      return this.#maintenanceRequestTimeoutMs;
    }
    return this.#requestTimeoutMs;
  }

  registerLiveQuery(liveId: string, query: RemoteLiveQuery<unknown>): void {
    this.#liveQueries.set(liveId, query);
  }

  unregisterLiveQuery(liveId: string): void {
    this.#liveQueries.delete(liveId);
  }

  #ensureHost(): UtilityProcess {
    if (this.#host) {
      return this.#host;
    }
    const host = utilityProcess.fork(this.#entryPath, [], {
      env: createDbHostEnvironment(),
      serviceName: 'brainstrike-db-host',
    });
    host.on('message', (message: unknown) => {
      this.#acceptMessage(message);
    });
    host.on('exit', (code) => {
      const error = new Error(`DB host exited with code ${code}.`);
      this.#host = null;
      this.#client = null;
      this.#failAllLiveQueries(error);
      this.#rejectAll(error);
    });
    host.on('error', (type, location) => {
      logger.error('DB host process error', { location, type });
    });
    this.#host = host;
    return host;
  }

  async #initialize(): Promise<RemoteDbClient> {
    try {
      await this.send<DbHostInitResult>({ kind: 'init' });
    } catch (error) {
      // Only a timeout can mean a wedged host. Any other rejection is a real initialization
      // failure the host has already recorded; killing it would discard that record, and the
      // next `db:diagnostics` would fork a fresh host that reports no failure at all.
      if (error instanceof DbHostRequestTimeoutError) {
        this.#terminateHost(error);
      }
      throw error;
    }
    this.#assertActive();
    this.#client = this.#createClient();
    return this.#client;
  }

  #createClient(): RemoteDbClient {
    return {
      exec: async (sql, params) =>
        await this.send({ kind: 'exec', sql, ...(params ? { params } : {}) }),
      live: {
        incrementalQuery: async <TRecord = unknown>(
          payload:
            | {
                readonly key: string;
                readonly limit?: number;
                readonly offset?: number;
                readonly params?: readonly unknown[] | null;
                readonly query: string;
              }
            | string,
          params?: readonly unknown[] | null,
          key?: string
        ) =>
          await this.#startLiveQuery<TRecord>(
            typeof payload === 'string'
              ? {
                  mode: 'incremental',
                  query: payload,
                  ...(params === undefined || params === null ? {} : { params }),
                  ...(key === undefined ? {} : { key }),
                }
              : { ...payload, mode: 'incremental' }
          ),
        query: async <TRecord = unknown>(
          payload:
            | {
                readonly limit?: number;
                readonly offset?: number;
                readonly params?: readonly unknown[] | null;
                readonly query: string;
              }
            | string,
          params?: readonly unknown[] | null
        ) =>
          await this.#startLiveQuery<TRecord>(
            typeof payload === 'string'
              ? {
                  mode: 'query',
                  query: payload,
                  ...(params === undefined || params === null ? {} : { params }),
                }
              : { ...payload, mode: 'query' }
          ),
      },
      maintenance: {
        exec: async (sql, params) =>
          await this.send({ kind: 'maintenance:exec', sql, ...(params ? { params } : {}) }),
      },
      query: async <TRecord = unknown>(
        sql: string,
        params?: readonly unknown[],
        options?: { readonly rowMode?: DbHostRowMode }
      ) =>
        await this.send<DbHostQueryResult<TRecord>>({
          kind: 'query',
          sql,
          ...(params ? { params } : {}),
          ...(options?.rowMode ? { rowMode: options.rowMode } : {}),
        }),
      transaction: async <TResult>(fn: (tx: RemoteDbTransaction) => Promise<TResult>) =>
        await this.#transaction(fn),
    };
  }

  async #startLiveQuery<TRecord>(payload: {
    readonly key?: string;
    readonly limit?: number;
    readonly mode: 'query' | 'incremental';
    readonly offset?: number;
    readonly params?: readonly unknown[] | null;
    readonly query: string;
  }): Promise<RemoteLiveQuery<TRecord>> {
    const requestPayload = {
      mode: payload.mode,
      query: payload.query,
      ...(payload.params === undefined || payload.params === null
        ? {}
        : { params: payload.params }),
      ...(payload.key === undefined ? {} : { key: payload.key }),
      ...(payload.limit === undefined ? {} : { limit: payload.limit }),
      ...(payload.offset === undefined ? {} : { offset: payload.offset }),
    };
    const result = await this.send<DbHostLiveStartResult>({
      kind: 'live:start',
      payload: requestPayload,
    }).catch((error: unknown) => {
      logger.error(
        {
          err: error,
          ...createLiveQueryDiagnostics(requestPayload),
        },
        'DB host live query start failed'
      );
      throw error;
    });
    const liveQuery = new RemoteLiveQuery<TRecord>(
      this,
      result.liveId,
      result.initialResults as DbHostQueryResult<TRecord>
    );
    this.registerLiveQuery(result.liveId, liveQuery as RemoteLiveQuery<unknown>);
    return liveQuery;
  }

  async #transaction<TResult>(fn: (tx: RemoteDbTransaction) => Promise<TResult>): Promise<TResult> {
    const transactionId = createTransactionId();
    const started = await this.send<DbHostTransactionStartResult>({
      kind: 'transaction:start',
      transactionId,
    });
    if (started.transactionId !== transactionId) {
      throw new Error(
        `DB host transaction acknowledgement mismatch: expected ${transactionId}, received ${started.transactionId}`
      );
    }
    const tx: RemoteDbTransaction = {
      exec: async (sql, params) =>
        await this.send({
          kind: 'transaction:exec',
          sql,
          transactionId,
          ...(params ? { params } : {}),
        }),
      query: async <TRecord = unknown>(
        sql: string,
        params?: readonly unknown[],
        options?: { readonly rowMode?: DbHostRowMode }
      ) =>
        await this.send<DbHostQueryResult<TRecord>>({
          kind: 'transaction:query',
          sql,
          transactionId,
          ...(params ? { params } : {}),
          ...(options?.rowMode ? { rowMode: options.rowMode } : {}),
        }),
    };
    try {
      const result = await fn(tx);
      await this.send({ kind: 'transaction:commit', transactionId });
      return result;
    } catch (error) {
      try {
        await this.send({ kind: 'transaction:rollback', transactionId });
      } catch (rollbackError) {
        logger.warn('Failed to roll back remote DB transaction', {
          error: rollbackError,
          transactionId,
        });
      }
      throw error;
    }
  }

  #acceptMessage(message: unknown): void {
    if (!isDbHostToMainMessage(message)) {
      logger.warn('Ignored malformed DB host message', { message });
      return;
    }
    if (message.kind === 'log') {
      logger[message.level](message.context ?? {}, message.message);
      return;
    }
    if (message.kind === 'live-update') {
      this.#liveQueries.get(message.liveId)?.acceptUpdate(message.results);
      return;
    }
    this.#acceptResponse(message);
  }

  #recordAbandonedRequest(id: string, request: AbandonedRequest): void {
    if (this.#abandoned.size >= MAX_ABANDONED_REQUESTS && !this.#evictStaleAbandonedRequest()) {
      // Keep the OLDEST entries: the host runs one statement at a time, so in
      // a timeout burst the oldest abandoned request is the statement that is
      // actually wedging the host — evicting it would silently drop exactly
      // the late-completion log this map exists to produce. The newer entries
      // are queued-behind victims whose late responses add little.
      logger.debug(
        { droppedRequestKind: request.requestKind, requestId: id },
        'Abandoned-request map full; not tracking further timed-out request'
      );
      return;
    }
    this.#abandoned.set(id, request);
  }

  // A request that NEVER replies (host alive, statement truly wedged
  // forever — no termination-triggering request kind ever fires to clear()
  // the map) would otherwise occupy its slot for the life of the host,
  // permanently disabling this log for every subsequent timeout once the map
  // fills. Once an entry has outlived the longest legitimate in-flight
  // request (the maintenance-timeout ceiling), it can only be dead weight —
  // evict it to make room for tracking new timeouts.
  #evictStaleAbandonedRequest(): boolean {
    const oldest = this.#abandoned.entries().next().value as [string, AbandonedRequest] | undefined;
    if (!oldest) {
      return false;
    }
    const [oldestId, oldestRequest] = oldest;
    const age = Date.now() - oldestRequest.startedAt;
    if (age < this.#maintenanceRequestTimeoutMs) {
      return false;
    }
    this.#abandoned.delete(oldestId);
    logger.debug(
      { ageMs: age, requestId: oldestId, requestKind: oldestRequest.requestKind },
      'Abandoned-request entry exceeded staleness ceiling without a late response; evicting'
    );
    return true;
  }

  #acceptResponse(message: DbHostResponseEnvelope): void {
    // The ledger sweep runs AFTER the channel has routed the response, so a
    // late response still finds its own abandoned entry even when that entry
    // has already outlived its window.
    this.#requests.accept(message);
    this.#clearStaleAbandonedRequests(Date.now());
  }

  #logLateResponse(requestId: string, message: DbHostResponseEnvelope): void {
    const abandoned = this.#abandoned.get(requestId);
    if (!abandoned) {
      return;
    }
    this.#abandoned.delete(requestId);
    // The statement outlived its IPC timeout and kept the single-threaded
    // host busy the whole time — surface how long it actually ran.
    logger.warn(
      {
        elapsedMs: Math.max(0, Date.now() - abandoned.startedAt),
        ok: message.ok,
        requestId,
        requestKind: abandoned.requestKind,
        timeoutMs: abandoned.timeoutMs,
      },
      'DB host request completed after timeout'
    );
  }

  #clearStaleAbandonedRequests(now: number): void {
    for (const [id, request] of this.#abandoned) {
      if (now - request.timedOutAt >= request.timeoutMs) {
        this.#abandoned.delete(id);
      }
    }
  }

  #rejectAll(error: Error): void {
    this.#requests.rejectAll(error);
    // A dead host can never deliver the late responses we were watching for.
    this.#abandoned.clear();
  }

  #failAllLiveQueries(error: Error): void {
    for (const liveQuery of this.#liveQueries.values()) {
      liveQuery.fail(error);
    }
    this.#liveQueries.clear();
  }

  #terminateHost(error: Error): void {
    const host = this.#host;
    if (!host) {
      return;
    }
    this.#host = null;
    this.#client = null;
    this.#failAllLiveQueries(error);
    this.#rejectAll(error);
    host.kill();
  }
}

let defaultManager: DefaultDbHostManager | null = null;
let closingDefaultManager: Promise<void> | null = null;

export function createDbHostManager(options?: DbHostManagerOptions): DbHostManager {
  return new DefaultDbHostManager(options);
}

export function getDbHostManager(): DbHostManager {
  if (closingDefaultManager) {
    throw new Error('DB host manager is closing; wait for closeDbHostManager() to complete.');
  }
  if (!defaultManager) {
    defaultManager = new DefaultDbHostManager();
  }
  return defaultManager;
}

export async function closeDbHostManager(): Promise<void> {
  if (closingDefaultManager) {
    await closingDefaultManager;
    return;
  }
  const manager = defaultManager;
  if (!manager) {
    return;
  }
  closingDefaultManager = manager.retire().finally(() => {
    if (defaultManager === manager) {
      defaultManager = null;
    }
    closingDefaultManager = null;
  });
  await closingDefaultManager;
}

export function resetDbHostManagerForTests(): void {
  defaultManager = null;
  closingDefaultManager = null;
}
