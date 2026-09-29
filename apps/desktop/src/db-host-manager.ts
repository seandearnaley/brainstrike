import { randomUUID } from 'node:crypto';
import { createLogger } from '@brainstrike/logging';
import type { DatabaseInitPhaseReport } from '@brainstrike/types';
import { utilityProcess } from 'electron';
import { resolveBundledSiblingPath } from './bundled-sibling-path';
import { cleanShutdownMarkerNamesPid } from './db-clean-shutdown-marker';
import { AbandonedRequestLedger } from './db-host-abandoned-requests';
import {
  DB_HOST_CLOSE_ACK_TIMEOUT_MS,
  DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS,
} from './db-host-close-budget';
import {
  DB_HOST_INIT_FIRST_REPORT_TIMEOUT_MS,
  resolveInitPhaseBudgetMs,
} from './db-host-init-budget';
import { DbHostCloseError, DbHostUnavailableError } from './db-host-lifecycle-errors';
import { closeDbHostProcess, DbHostProcess, killWedgedHost } from './db-host-process';
import {
  type DbHostDiagnosticsResult,
  type DbHostInitResult,
  type DbHostLiveQueryDiagnostics,
  type DbHostLiveStartResult,
  type DbHostManagerDiagnosticsResult,
  type DbHostProgressEnvelope,
  type DbHostQueryResult,
  type DbHostRequest,
  type DbHostRequestEnvelope,
  type DbHostResponseEnvelope,
  type DbHostRowMode,
  type DbHostTransactionStartResult,
  isDbHostProgressEnvelope,
  isDbHostToMainMessage,
  toError,
} from './db-host-protocol';
import {
  createLiveQueryDiagnostics,
  createRequestTimeoutDiagnostics,
  type RequestTimeoutDiagnostics,
} from './db-host-request-diagnostics';
import { DbHostRequestTimeoutError } from './db-host-timeout-error';
import { DB_PROFILE_ENV, DB_ROOT_PATH_ENV, SERIALIZE_PGLITE_INIT_ENV } from './db-runtime-env';
import {
  resolveDesktopDatabaseLocation,
  resolveDesktopDatabaseProfileDirectory,
} from './desktop-database-location';
import { isDesktopShuttingDown } from './desktop-shutdown-state';
import {
  createHostRequestChannel,
  type HostRequestChannel,
  type HostRequestTimeoutContext,
  type HostRequestTimeoutDecision,
} from './platform/host-request-channel';
import { summarizeMalformedMessage } from './platform/summarize-malformed-message';

export { DbHostRequestTimeoutError } from './db-host-timeout-error';

const logger = createLogger('DbHostManager');

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const PREVIOUS_HOST_ALIVE_MESSAGE =
  'DB host is unavailable: the previous host has not exited and may still own the database.';

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

class DefaultDbHostManager implements DbHostManager {
  readonly #entryPath: string;
  readonly #liveQueries = new Map<string, RemoteLiveQuery<unknown>>();
  readonly #requests: HostRequestChannel<
    DbHostRequestEnvelope,
    DbHostResponseEnvelope | DbHostProgressEnvelope
  >;
  readonly #abandoned: AbandonedRequestLedger;
  readonly #closeTimeoutMs: number;
  readonly #initializationTimeoutMs: number;
  readonly #maintenanceRequestTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  // Why no request may fork a host: retired, or its host closed itself on a signal aimed at it.
  #unavailable: Error | null = null;
  #client: RemoteDbClient | null = null;
  #closing: Promise<void> | null = null;
  #host: DbHostProcess | null = null;
  #initialization: Promise<RemoteDbClient> | null = null;
  // The phase the running `init` last reported; null before its first report. Main-side state only.
  #initPhase: DatabaseInitPhaseReport | null = null;
  // A detached host stays here until its own `exit` is observed: an exit is the only proof it
  // no longer owns the database, so no request forks a replacement (or reports a close) meanwhile.
  #departingHost: DbHostProcess | null = null;

  constructor(options: DbHostManagerOptions = {}) {
    this.#entryPath = options.entryPath ?? resolveDbHostEntryPath();
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DB_HOST_CLOSE_ACK_TIMEOUT_MS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#maintenanceRequestTimeoutMs =
      options.maintenanceRequestTimeoutMs ?? Math.max(10 * 60_000, this.#requestTimeoutMs);
    this.#abandoned = new AbandonedRequestLedger(this.#maintenanceRequestTimeoutMs);
    this.#initializationTimeoutMs =
      options.initializationTimeoutMs ??
      Math.max(DB_HOST_INIT_FIRST_REPORT_TIMEOUT_MS, this.#requestTimeoutMs);
    this.#requests = createHostRequestChannel<
      DbHostRequestEnvelope,
      DbHostResponseEnvelope | DbHostProgressEnvelope
    >({
      // Progress is liveness (the host reports what it is about to do, then goes silent inside a
      // synchronous statement), and each report carries the budget of the phase it announces.
      isProgress: (response) => response.kind === 'progress',
      // The DB host owns its own late-response ledger; the channel's default
      // warn would report an id this manager can describe far better.
      onLateResponse: (requestId, response) => {
        this.#logLateResponse(requestId, response);
      },
      onTimeout: (envelope, context) => this.#decideRequestTimeout(envelope, context),
      progressTimeoutMs: (envelope, response) =>
        response.kind === 'progress' && envelope.request.kind === 'init'
          ? resolveInitPhaseBudgetMs(response.report)
          : this.#getRequestTimeoutMs(envelope.request),
      requestId: (envelope) => envelope.id,
      responseId: (response) => response.id,
      role: 'DB host',
      // `send()` has already forked the host on the statement immediately
      // before this runs, so this resolves to that same process; it can only
      // fork when the host died in between, which is the behaviour a request
      // arriving after an exit already had.
      send: (envelope) => {
        this.#ensureHost().handle.postMessage(envelope);
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
      hostPid: this.#host?.handle.pid ?? null,
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
    this.#unavailable = new Error('DB host manager is retired.');
    await this.close();
  }

  #assertActive(): void {
    if (this.#unavailable) {
      throw this.#unavailable;
    }
  }

  /** True until the host this manager detached has been observed to exit. */
  hasDepartingHost(): boolean {
    return this.#departingHost !== null;
  }

  /**
   * Resolves only when the database is closed AND the host has exited; else `DbHostCloseError`.
   *
   * With no live host it resolves once any earlier host has been observed to exit, however that
   * host went: after a failed close (or kill) whose exit is later observed, a repeated close
   * RESOLVES. Nothing owns the directory any more, and the absent clean-shutdown marker records
   * that session as unclean, so the next open reports `unclean`. Guarded by the `afterExit` case of
   * "never reports a repeated close as success while the host may still be alive".
   * Either way `#closing` is set for the whole close, so a request waiting on a departing host
   * re-checks, sees it, and rejects instead of forking a host as the close reports closed.
   */
  async close(): Promise<void> {
    if (this.#closing) {
      return await this.#closing;
    }
    const host = this.#host;
    if (!(host || this.#departingHost)) {
      return; // nothing to close and nothing that could still be alive
    }
    const closing = (
      host
        ? closeDbHostProcess(host, {
            acknowledge: async () => await this.send({ kind: 'close' }),
            ackTimeoutMs: this.#closeTimeoutMs,
            confirmCleanExit: (pid) =>
              cleanShutdownMarkerNamesPid(resolveDesktopDatabaseProfileDirectory(), pid),
            detach: () => this.#detachHost(new Error('DB host closed.')),
          })
        : this.#assertDepartingHostExited()
    ).finally(() => {
      // Cleared before close() settles, so a caller resuming from it forks at once.
      this.#closing = null;
    });
    this.#closing = closing;
    return await closing;
  }

  /** A close with no host to close is a success only if no earlier host may still be alive. */
  async #assertDepartingHostExited(): Promise<void> {
    const departing = this.#departingHost;
    if (departing && !(await departing.waitForExit(DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS))) {
      throw new DbHostCloseError(
        'exit-timeout',
        'DB host has not exited after an earlier close or kill; it may still own the database.'
      );
    }
  }

  #detachHost(error: Error): void {
    const host = this.#host;
    this.#host = null;
    this.#client = null;
    if (host && host.exitCode === undefined) {
      this.#departingHost = host;
      void host.exited.then(() => {
        if (this.#departingHost === host) {
          this.#departingHost = null;
        }
      });
    }
    this.#rejectAll(error);
    this.#failAllLiveQueries(error);
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

  async send<TResult = unknown>(
    request: DbHostRequest,
    options: { readonly onPhase?: (report: DatabaseInitPhaseReport) => void } = {}
  ): Promise<TResult> {
    if (request.kind !== 'close') {
      // Synchronous unless a host is departing, so a request issued before `close()` is still
      // posted before the close envelope. `#initialize()` is gated here too (its `init` request).
      const admission = this.#admit();
      if (admission) {
        await admission;
      }
    }
    this.#ensureHost();
    const envelope: DbHostRequestEnvelope = {
      id: createRequestId(),
      kind: 'request',
      request,
    };
    const response = await this.#requests.request(envelope, {
      onProgress: (progress) => {
        if (progress.kind === 'progress') {
          options.onPhase?.(progress.report);
        }
      },
    });
    if (response.kind !== 'response') {
      // The channel settles a request only on a non-progress response.
      throw new Error(`DB host request ${envelope.id} settled with a ${response.kind} envelope.`);
    }
    if (!response.ok) {
      throw toError(response.error);
    }
    return response.result as TResult;
  }

  /**
   * The gate every request passes before it may fork a host. Rejects while the manager is retired
   * or closing. While a departing host has not exited it waits at most one post-SIGKILL budget for
   * that exit, then rejects: never a fork, never an unbounded wait. Everything is re-checked after
   * each wait, so a request that was waiting cannot fork after a retire or a close began.
   */
  #admit(): Promise<void> | undefined {
    this.#assertActive();
    if (this.#closing) {
      throw new DbHostUnavailableError('DB host is unavailable: the database is closing.');
    }
    const departing = this.#departingHost;
    if (!departing) {
      return undefined;
    }
    return departing.waitForExit(DB_HOST_EXIT_AFTER_KILL_TIMEOUT_MS).then(async (exited) => {
      if (!exited) {
        throw new DbHostUnavailableError(PREVIOUS_HOST_ALIVE_MESSAGE);
      }
      await this.#admit();
    });
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
    const abandonedState = this.#abandoned.state(context.timedOutAt);
    const phase = request.kind === 'init' ? this.#initPhase : null;
    const error = new DbHostRequestTimeoutError({
      ...abandonedState,
      pendingCount: context.pendingCount,
      phase,
      progressCount: context.progressCount,
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
        phase,
        progressCount: context.progressCount,
        requestId: envelope.id,
        timeoutMs: context.timeoutMs,
        willTerminateHost,
      },
      'DB host request timed out'
    );
    this.#abandoned.record(envelope.id, {
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
        this.#terminateHost(terminationError, createRequestTimeoutDiagnostics(request));
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

  #ensureHost(): DbHostProcess {
    if (this.#host) {
      return this.#host;
    }
    // Defense in depth: `#admit()` already waited for, or rejected on, a departing host.
    if (this.#departingHost) {
      throw new DbHostUnavailableError(PREVIOUS_HOST_ALIVE_MESSAGE);
    }
    // Only an existing host may serve shutdown-time work; a fork now would re-open a closed database.
    if (isDesktopShuttingDown()) {
      throw new DbHostUnavailableError('DB host is unavailable: the application is shutting down.');
    }
    const host = new DbHostProcess(
      utilityProcess.fork(this.#entryPath, [], {
        env: createDbHostEnvironment(),
        serviceName: 'brainstrike-db-host',
      })
    );
    host.handle.on('message', (message: unknown) => {
      this.#acceptMessage(message);
    });
    host.handle.on('exit', (code) => {
      if (this.#host !== host) {
        return; // detached: its requests and live queries are already failed
      }
      this.#unavailable ??= host.unavailableAfterOwnExit();
      this.#detachHost(new Error(`DB host exited with code ${code}.`));
    });
    host.handle.on('error', (type, location) => {
      logger.error('DB host process error', { location, type });
    });
    this.#host = host;
    return host;
  }

  async #initialize(): Promise<RemoteDbClient> {
    this.#initPhase = null;
    try {
      await this.send<DbHostInitResult>(
        { kind: 'init' },
        {
          onPhase: (report) => {
            this.#initPhase = report;
          },
        }
      );
    } catch (error) {
      // Only a timeout can mean a wedged host. Any other rejection is a real initialization
      // failure the host has already recorded; killing it would discard that record, and the
      // next `db:diagnostics` would fork a fresh host that reports no failure at all.
      if (error instanceof DbHostRequestTimeoutError) {
        this.#terminateHost(error, { requestKind: 'init' });
      }
      throw error;
    } finally {
      this.#initPhase = null;
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
      // Shape only: DB host traffic carries query results, which must never reach the log.
      logger.warn('Ignored malformed DB host message', summarizeMalformedMessage(message));
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
    if (message.kind === 'progress') {
      this.#acceptProgress(message);
      return;
    }
    if (message.kind === 'response') {
      this.#acceptResponse(message);
    }
  }

  /**
   * A progress report re-arms a deadline, so only a structurally valid one, for the `init` request,
   * gets that far. Anything else is logged at error and dropped: the running deadline stands.
   */
  #acceptProgress(message: unknown): void {
    if (!isDbHostProgressEnvelope(message)) {
      logger.error(
        'Dropped malformed DB host progress envelope',
        summarizeMalformedMessage(message)
      );
      return;
    }
    const pending = this.#requests.inFlight().find((envelope) => envelope.id === message.id);
    if (!pending) {
      // A report for a request that already settled or timed out re-arms nothing; drop it here so
      // only terminal responses ever reach the channel's late-response path.
      logger.debug('Dropped DB host progress for a request no longer in flight', {
        requestId: message.id,
      });
      return;
    }
    if (pending.request.kind !== 'init') {
      logger.error('Dropped DB host progress for a request that is not init', {
        requestId: message.id,
        requestKind: pending.request.kind,
      });
      return;
    }
    this.#requests.accept(message);
  }

  #acceptResponse(message: DbHostResponseEnvelope): void {
    // The ledger sweep runs AFTER the channel has routed the response, so a
    // late response still finds its own abandoned entry even when that entry
    // has already outlived its window.
    this.#requests.accept(message);
    this.#abandoned.clearStale(Date.now());
  }

  #logLateResponse(
    requestId: string,
    message: DbHostResponseEnvelope | DbHostProgressEnvelope
  ): void {
    if (message.kind === 'progress') {
      // Unreachable: #acceptProgress drops progress with no request in flight. This narrows the type.
      return;
    }
    const abandoned = this.#abandoned.take(requestId);
    if (!abandoned) {
      return;
    }
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

  // The only way out of a statement that never returns: SIGKILL, and no replacement host
  // forks until the exit is observed. A close in flight owns the host's lifecycle instead.
  #terminateHost(error: Error, diagnostics: RequestTimeoutDiagnostics): void {
    const host = this.#host;
    // While closing, the request-timeout `rejectAll` also fails the close request itself, which
    // drives the close ladder's own SIGKILL; a second kill here would race it.
    if (!host || this.#closing) {
      return;
    }
    this.#detachHost(error);
    void killWedgedHost(host, { ...diagnostics, reason: 'request-timeout' });
  }
}

let defaultManager: DefaultDbHostManager | null = null;
let closingDefaultManager: Promise<void> | null = null;
// A default manager whose close FAILED while its host may still be alive. It outlives its
// replacement slot so the barrier does too: nothing forks from any manager until that host exits.
let unexitedDefaultManager: DefaultDbHostManager | null = null;

export function createDbHostManager(options?: DbHostManagerOptions): DbHostManager {
  return new DefaultDbHostManager(options);
}

export function getDbHostManager(): DbHostManager {
  if (closingDefaultManager) {
    throw new Error('DB host manager is closing; wait for closeDbHostManager() to complete.');
  }
  if (unexitedDefaultManager?.hasDepartingHost()) {
    throw new DbHostUnavailableError(PREVIOUS_HOST_ALIVE_MESSAGE);
  }
  unexitedDefaultManager = null; // its host has exited (or there never was one)
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
    // Same rule as a repeated close of one manager: no success while a host may be alive.
    const unexited = unexitedDefaultManager;
    if (unexited) {
      await unexited.close();
      if (unexitedDefaultManager === unexited) {
        unexitedDefaultManager = null;
      }
    }
    return;
  }
  closingDefaultManager = manager
    .retire()
    .catch((error: unknown) => {
      unexitedDefaultManager = manager;
      throw error;
    })
    .finally(() => {
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
  unexitedDefaultManager = null;
}
