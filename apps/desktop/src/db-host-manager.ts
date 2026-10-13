import { randomUUID } from 'node:crypto';
import { BoundaryFailureError, processLost } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { DatabaseInitPhaseReport } from '@brainstrike/types';
import { utilityProcess } from 'electron';
import { resolveBundledSiblingPath } from './bundled-sibling-path';
import {
  type ChildGenerationContext,
  type ChildSupervisor,
  createChildSupervisor,
} from './child-supervisor';
import { cleanShutdownMarkerNamesPid } from './db-clean-shutdown-marker';
import { AbandonedRequestLedger } from './db-host-abandoned-requests';
import { DB_HOST_CLOSE_ACK_TIMEOUT_MS } from './db-host-close-budget';
import {
  DB_HOST_INIT_FIRST_REPORT_TIMEOUT_MS,
  DB_HOST_INIT_MAX_BUDGET_MS,
  resolveInitPhaseBudgetMs,
} from './db-host-init-budget';
import { DbHostCloseError, DbHostUnavailableError } from './db-host-lifecycle-errors';
import { DbHostProcess } from './db-host-process';
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
  type DbHostTransactionStartResult,
  isDbHostToMainMessage,
  parseDbHostProgressEnvelope,
  toError,
} from './db-host-protocol';
import {
  type RemoteDbClient,
  type RemoteDbTransaction,
  RemoteLiveQuery,
} from './db-host-remote-client';
import {
  createLiveQueryDiagnostics,
  createRequestTimeoutDiagnostics,
  type RequestTimeoutDiagnostics,
} from './db-host-request-diagnostics';
import { DbHostRequestTimeoutError } from './db-host-timeout-error';
import { InitAttemptGuard } from './db-init-attempt-guard';
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
import { summarizeMalformedMessage, truncateForLog } from './platform/summarize-malformed-message';

export type {
  RemoteDbClient,
  RemoteDbLiveQuery,
  RemoteDbTransaction,
} from './db-host-remote-client';
export { DbHostRequestTimeoutError } from './db-host-timeout-error';

const logger = createLogger('DbHostManager');

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const PREVIOUS_HOST_ALIVE_MESSAGE =
  'DB host is unavailable: the previous host has not exited and may still own the database.';

export interface DbHostManager {
  readonly applyManagedCacheBatch: (payload: unknown) => Promise<void>;
  readonly close: () => Promise<void>;
  readonly getDatabase: () => Promise<RemoteDbClient>;
  readonly getDiagnostics: () => Promise<DbHostManagerDiagnosticsResult>;
  readonly getLiveQueryDiagnosticsForTests: () => Promise<DbHostLiveQueryDiagnostics>;
  readonly insertChunksAndEnqueueEmbeddingJobs: (payload: unknown) => Promise<void>;
  readonly invalidateManagedCacheEntriesByIdentity: (payload: unknown) => Promise<unknown>;
  readonly reset: () => Promise<void>;
  /**
   * The only way, besides a reset, out of a stop after repeated init timeouts: removes main's
   * record, joins the old physical generation and awaits a fresh init. `noDeadline` arms that init with the
   * longest timer instead of the phase budgets. Throws if the record cannot be removed.
   */
  readonly retryInit: (options: { readonly noDeadline: boolean }) => Promise<void>;
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
  // Windows ASAR fs.open/createReadStream extracts extension bundles through
  // Chromium's temp directory. Stripping TEMP/TMP makes packaged PGlite fail
  // before SQL with misleading ENOENT errors for archives that are present.
  // https://www.electronjs.org/docs/latest/tutorial/asar-archives#extra-unpacking-on-some-apis
  const allowedKeys = ['NODE_ENV', 'LOG_LEVEL', 'TEMP', 'TMP'] as const;
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

interface DbHostGeneration {
  readonly context: ChildGenerationContext;
  readonly host: DbHostProcess;
  initialization?: Promise<RemoteDbClient> | undefined;
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
  // Permanent retirement belongs to the default-manager identity, not a child restart policy.
  #unavailable: Error | null = null;
  // Protocol handle only. ChildSupervisor exclusively owns this generation's lifetime.
  #generation: DbHostGeneration | null = null;
  #supervisor: ChildSupervisor<DbHostGeneration> | null = null;
  readonly #supervisorReady: Promise<ChildSupervisor<DbHostGeneration>>;
  // The phase the running `init` last reported; null before its first report. Main-side state only.
  #initPhase: DatabaseInitPhaseReport | null = null;
  readonly #attempts = new InitAttemptGuard();
  // `retryInit({ noDeadline })` arms the NEXT init only: pending until it starts, suspended while it runs.
  #pendingNoDeadline = false;
  #initDeadlineSuspended = false;
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
    // The window a timeout records: only a whole, armable number of milliseconds can expire and be recorded.
    if (
      !Number.isSafeInteger(this.#initializationTimeoutMs) ||
      this.#initializationTimeoutMs < 1 ||
      this.#initializationTimeoutMs > DB_HOST_INIT_MAX_BUDGET_MS
    ) {
      throw new RangeError(
        `The DB host initialization window must be 1..${DB_HOST_INIT_MAX_BUDGET_MS} ms; received ${this.#initializationTimeoutMs}.`
      );
    }
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
          ? this.#initPhaseBudgetMs(response.report)
          : this.#getRequestTimeoutMs(envelope.request),
      requestId: (envelope) => envelope.id,
      responseId: (response) => response.id,
      role: 'DB host',
      // Posting never acquires or replaces a process. Admission and this synchronous
      // write refer to the same current physical generation, including its close ACK.
      send: (envelope) => {
        const generation = this.#generation;
        if (!generation) {
          throw new DbHostUnavailableError('DB host has no admitted physical generation.');
        }
        generation.host.handle.postMessage(envelope);
      },
      timeoutMs: (envelope) => this.#getRequestTimeoutMs(envelope.request),
    });
    this.#supervisorReady = createChildSupervisor<DbHostGeneration>({
      create: (context) => this.#createGeneration(context),
      restart: 'never',
    }).then((supervisor) => {
      this.#supervisor = supervisor;
      return supervisor;
    });
  }

  async getDatabase(): Promise<RemoteDbClient> {
    const admitted = this.#admit();
    const generation = admitted instanceof Promise ? await admitted : admitted;
    this.#assertGeneration(generation);
    // A database failure is retained separately from physical process readiness.
    // Diagnostics may still use this live process; passive demand never retries init.
    generation.initialization ??= this.#initialize(generation);
    return await generation.initialization;
  }

  async getDiagnostics(): Promise<DbHostManagerDiagnosticsResult> {
    // While stopped, main answers from its own record: a fresh host would report no failure at all.
    const stop = this.#attempts.readStop();
    if (stop) {
      return this.#attempts.stoppedDiagnostics(stop);
    }
    const result = await this.send<DbHostDiagnosticsResult>({ kind: 'diagnostics' });
    const { activeLiveQueryCount, ...databaseDiagnostics } = result;
    void activeLiveQueryCount;
    return {
      ...databaseDiagnostics,
      hostPid: this.#generation?.host.handle.pid ?? null,
      initStop: null,
    };
  }

  async retryInit(options: { readonly noDeadline: boolean }): Promise<void> {
    this.#assertActive();
    // If removing the attempt record fails, nothing rearms or replaces the owner.
    this.#attempts.retry();
    this.#pendingNoDeadline = options.noDeadline;
    const supervisor = this.#supervisor ?? (await this.#supervisorReady);
    await supervisor.restart();
    await this.getDatabase();
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
    if (this.#generation) {
      this.#generation.initialization = undefined;
    }
    // The reset deleted the profile, and the record with it: nothing of an earlier attempt applies.
    this.#attempts.reset();
    this.#pendingNoDeadline = false;
  }

  // Default-manager replacement is permanent; only explicit retry may reuse a
  // closed manager. Retained clients must never fork another owner.
  async retire(): Promise<void> {
    this.#unavailable = new Error('DB host manager is retired.');
    await this.close();
  }

  #assertActive(): void {
    if (this.#unavailable) {
      throw this.#unavailable;
    }
  }

  /** An actual process handle, not a second lifetime state or an exit-timeout guess. */
  hasDepartingHost(): boolean {
    return this.#generation !== null && this.#generation.host.exitCode === undefined;
  }

  close(): Promise<void> {
    const reason = new DbHostUnavailableError('DB host is unavailable: the database is closing.');
    // On an already constructed owner, stop fences its signal synchronously before
    // this method returns. The same owner joins ACK and physical exit afterward.
    return this.#supervisor
      ? this.#supervisor.stop(reason)
      : this.#supervisorReady.then((supervisor) => supervisor.stop(reason));
  }

  #detachProtocol(error: Error): void {
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
    options: { readonly onPhase?: (report: DatabaseInitPhaseReport) => void } = {},
    expected?: DbHostGeneration
  ): Promise<TResult> {
    const admitted = this.#admit();
    const generation = admitted instanceof Promise ? await admitted : admitted;
    this.#assertGeneration(expected ?? generation);
    return await this.#sendOwned<TResult>(generation, request, options);
  }

  async #sendOwned<TResult = unknown>(
    generation: DbHostGeneration,
    request: DbHostRequest,
    options: { readonly onPhase?: (report: DatabaseInitPhaseReport) => void } = {}
  ): Promise<TResult> {
    if (this.#generation !== generation) {
      throw new DbHostUnavailableError('DB host protocol generation is no longer current.');
    }
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

  #assertGeneration(generation: DbHostGeneration): void {
    this.#assertActive();
    generation.context.signal.throwIfAborted();
    if (this.#generation !== generation) {
      throw new DbHostUnavailableError('DB host protocol generation is no longer current.');
    }
  }

  #admit(): DbHostGeneration | Promise<DbHostGeneration> {
    this.#assertActive();
    if (this.#generation) {
      this.#assertGeneration(this.#generation);
      return this.#generation;
    }
    return this.#supervisor
      ? this.#supervisor.acquire()
      : this.#supervisorReady.then((supervisor) => supervisor.acquire());
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
      return this.#initDeadlineSuspended
        ? DB_HOST_INIT_MAX_BUDGET_MS
        : this.#initializationTimeoutMs;
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

  #createGeneration(context: ChildGenerationContext) {
    this.#assertActive();
    this.#attempts.assertNotStopped();
    if (isDesktopShuttingDown()) {
      throw new DbHostUnavailableError('DB host is unavailable: the application is shutting down.');
    }
    const host = new DbHostProcess(
      utilityProcess.fork(this.#entryPath, [], {
        env: createDbHostEnvironment(),
        serviceName: 'brainstrike-db-host',
      })
    );
    const generation: DbHostGeneration = { context, host };
    this.#generation = generation;
    host.handle.on('message', (message: unknown) => {
      // Retirement still needs this process's terminal ACK; only replacement
      // identity, not an aborted work signal, makes its protocol callbacks stale.
      if (this.#generation === generation) {
        this.#acceptMessage(message);
      }
    });
    host.handle.on('exit', (code) => {
      if (this.#generation !== generation) {
        return;
      }
      const cause = context.signal.aborted
        ? context.signal.reason
        : (host.unavailableAfterOwnExit() ??
          new BoundaryFailureError(processLost({ child: 'db-host', exitCode: code })));
      if (!context.signal.aborted) {
        void context.lost(cause).catch((error: unknown) => {
          logger.error({ err: error }, 'DB host loss publication failed');
        });
      }
      this.#detachProtocol(cause);
    });
    host.handle.on('error', (type, location) => {
      logger.error('DB host process error', { location, type });
    });
    return {
      close: (reason: unknown) => this.#releaseGeneration(generation, reason),
      // Fork admission is physical readiness, not successful database initialization.
      ready: Promise.resolve(generation),
    };
  }

  async #releaseGeneration(generation: DbHostGeneration, reason: unknown): Promise<void> {
    const { host } = generation;
    if (host.exitCode === undefined) {
      if (reason instanceof DbHostRequestTimeoutError) {
        await host.terminate({ reason: 'request-timeout', requestKind: reason.requestKind });
        if (host.exitCode === undefined) {
          throw new DbHostCloseError('exit-timeout', PREVIOUS_HOST_ALIVE_MESSAGE, {
            cause: reason,
          });
        }
      } else {
        await host.close({
          acknowledge: () => this.#sendOwned(generation, { kind: 'close' }),
          ackTimeoutMs: this.#closeTimeoutMs,
          confirmCleanExit: (pid) =>
            cleanShutdownMarkerNamesPid(resolveDesktopDatabaseProfileDirectory(), pid),
          detach: () => this.#detachProtocol(new Error('DB host closed.')),
        });
      }
    }
    if (this.#generation === generation) {
      this.#generation = null;
    }
  }

  async #initialize(generation: DbHostGeneration): Promise<RemoteDbClient> {
    this.#attempts.assertNotStopped();
    this.#initDeadlineSuspended = this.#pendingNoDeadline;
    this.#pendingNoDeadline = false;
    this.#initPhase = null;
    try {
      await this.#sendOwned<DbHostInitResult>(
        generation,
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
        this.#attempts.recordTimeout(error, generation.host.handle.pid ?? null);
        this.#terminateHost(error, { requestKind: 'init' });
      }
      throw error;
    } finally {
      this.#initPhase = null;
      this.#initDeadlineSuspended = false;
    }
    this.#attempts.recordSuccess();
    this.#assertGeneration(generation);
    return this.#createClient(generation);
  }

  #initPhaseBudgetMs(report: DatabaseInitPhaseReport): number {
    return this.#initDeadlineSuspended
      ? DB_HOST_INIT_MAX_BUDGET_MS
      : resolveInitPhaseBudgetMs(report);
  }

  #createClient(generation: DbHostGeneration): RemoteDbClient {
    const sendForGeneration = <TResult = unknown>(request: DbHostRequest): Promise<TResult> =>
      this.send<TResult>(request, {}, generation);
    return {
      exec: async (sql, params) =>
        await sendForGeneration({ kind: 'exec', sql, ...(params ? { params } : {}) }),
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
            generation,
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
            generation,
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
          await sendForGeneration({ kind: 'maintenance:exec', sql, ...(params ? { params } : {}) }),
      },
      query: async <TRecord = unknown>(sql: string, params?: readonly unknown[]) =>
        await sendForGeneration<DbHostQueryResult<TRecord>>({
          kind: 'query',
          sql,
          ...(params ? { params } : {}),
        }),
      transaction: async <TResult>(fn: (tx: RemoteDbTransaction) => Promise<TResult>) =>
        await this.#transaction(generation, fn),
    };
  }

  async #startLiveQuery<TRecord>(
    generation: DbHostGeneration,
    payload: {
      readonly key?: string;
      readonly limit?: number;
      readonly mode: 'query' | 'incremental';
      readonly offset?: number;
      readonly params?: readonly unknown[] | null;
      readonly query: string;
    }
  ): Promise<RemoteLiveQuery<TRecord>> {
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
    const result = await this.send<DbHostLiveStartResult>(
      {
        kind: 'live:start',
        payload: requestPayload,
      },
      {},
      generation
    ).catch((error: unknown) => {
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
      {
        send: (request) => this.send(request, {}, generation),
        unregisterLiveQuery: (liveId) => this.unregisterLiveQuery(liveId),
      },
      result.liveId,
      result.initialResults as DbHostQueryResult<TRecord>
    );
    this.registerLiveQuery(result.liveId, liveQuery as RemoteLiveQuery<unknown>);
    return liveQuery;
  }

  async #transaction<TResult>(
    generation: DbHostGeneration,
    fn: (tx: RemoteDbTransaction) => Promise<TResult>
  ): Promise<TResult> {
    const sendForGeneration = <T = unknown>(request: DbHostRequest): Promise<T> =>
      this.send<T>(request, {}, generation);
    const transactionId = createTransactionId();
    const started = await sendForGeneration<DbHostTransactionStartResult>({
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
        await sendForGeneration({
          kind: 'transaction:exec',
          sql,
          transactionId,
          ...(params ? { params } : {}),
        }),
      query: async <TRecord = unknown>(sql: string, params?: readonly unknown[]) =>
        await sendForGeneration<DbHostQueryResult<TRecord>>({
          kind: 'transaction:query',
          sql,
          transactionId,
          ...(params ? { params } : {}),
        }),
    };
    try {
      const result = await fn(tx);
      await sendForGeneration({ kind: 'transaction:commit', transactionId });
      return result;
    } catch (error) {
      try {
        await sendForGeneration({ kind: 'transaction:rollback', transactionId });
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
      // Bounded shape only: DB host traffic carries query results. Key names, counts and a top-level
      // string `type` (if any) are logged, each truncated; no other value is.
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
  #acceptProgress(raw: unknown): void {
    // Parsed, not merely validated: only the known fields go on, so nothing extra the host sent
    // reaches #initPhase, the timeout log or the error.
    const message = parseDbHostProgressEnvelope(raw);
    if (!message) {
      logger.error('Dropped malformed DB host progress envelope', summarizeMalformedMessage(raw));
      return;
    }
    const pending = this.#requests.inFlight().find((envelope) => envelope.id === message.id);
    if (!pending) {
      // A report for a request that already settled or timed out re-arms nothing; drop it here so
      // only terminal responses ever reach the channel's late-response path.
      logger.debug('Dropped DB host progress for a request no longer in flight', {
        requestId: truncateForLog(message.id),
      });
      return;
    }
    if (pending.request.kind !== 'init') {
      logger.error('Dropped DB host progress for a request that is not init', {
        requestId: truncateForLog(message.id),
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

  #terminateHost(error: Error, diagnostics: RequestTimeoutDiagnostics): void {
    const generation = this.#generation;
    // Stop's close ladder already owns physical release and its terminal ACK.
    if (!generation || generation.context.signal.aborted) {
      return;
    }
    const lost = generation.context.lost(error);
    this.#detachProtocol(error);
    void lost
      .then(async () => {
        const supervisor = this.#supervisor ?? (await this.#supervisorReady);
        await supervisor.retireLost();
      })
      .catch((cause: unknown) => {
        logger.error({ err: cause, ...diagnostics }, 'DB host physical retirement failed');
      });
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
