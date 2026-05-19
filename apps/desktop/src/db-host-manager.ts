import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils/logger';
import { app, type UtilityProcess, utilityProcess } from 'electron';
import type {
  DbHostDiagnosticsResult,
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
import { DB_ROOT_PATH_ENV, SERIALIZE_PGLITE_INIT_ENV } from './db-runtime-env';

const logger = createLogger('DbHostManager');

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_INIT_REQUEST_TIMEOUT_MS = 75_000;
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
  readonly query: <TRecord = unknown>(
    sql: string,
    params?: readonly unknown[]
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
  readonly transaction: <TResult>(
    fn: (tx: RemoteDbTransaction) => Promise<TResult>
  ) => Promise<TResult>;
}

export interface DbHostManager {
  readonly applyManagedCacheBatch: (payload: unknown) => Promise<void>;
  readonly close: () => Promise<void>;
  readonly getDatabase: () => Promise<RemoteDbClient>;
  readonly getDiagnostics: () => Promise<DbHostDiagnosticsResult>;
  readonly reset: () => Promise<void>;
}

export interface DbHostManagerOptions {
  readonly closeTimeoutMs?: number;
  readonly entryPath?: string;
  readonly initRequestTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

interface PendingRequest {
  readonly reject: (reason: unknown) => void;
  readonly resolve: (value: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function toError(error: DbHostSerializedError): Error {
  const normalized = new Error(error.message);
  normalized.name = error.name ?? 'DbHostError';
  if (error.stack) {
    normalized.stack = error.stack;
  }
  if (error.code) {
    (normalized as Error & { code?: string }).code = error.code;
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

function resolveDefaultEntryPath(): string {
  const currentModuleFilename =
    typeof module.filename === 'string' && module.filename.length > 0
      ? module.filename
      : path.join(process.cwd(), 'db-host-manager.js');
  return path.join(path.dirname(currentModuleFilename), 'db-host-entry.js');
}

function resolveDatabaseRootPathForHost(): string {
  const configuredRootPath = process.env[DB_ROOT_PATH_ENV]?.trim();
  // Dev shells can leak literal "undefined" environment strings; the host manager itself
  // always passes a concrete resolved path through createDbHostEnvironment().
  if (configuredRootPath && configuredRootPath.toLowerCase() !== 'undefined') {
    return configuredRootPath;
  }
  if (!app || typeof app.getPath !== 'function') {
    throw new Error(
      `Cannot start DB host because Electron app path resolution is unavailable and ${DB_ROOT_PATH_ENV} is not set.`
    );
  }
  if (process.env['NODE_ENV'] === 'test' || process.argv.includes('--test-mode')) {
    return app.getPath('userData');
  }
  const dbDirName = process.env['NODE_ENV'] === 'production' ? 'BrainStrike' : 'BrainStrike-dev';
  return path.join(app.getPath('documents'), dbDirName);
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
  environment[DB_ROOT_PATH_ENV] = resolveDatabaseRootPathForHost();
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

class DefaultDbHostManager implements DbHostManager {
  readonly #entryPath: string;
  readonly #liveQueries = new Map<string, RemoteLiveQuery<unknown>>();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #closeTimeoutMs: number;
  readonly #initRequestTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  #client: RemoteDbClient | null = null;
  #host: UtilityProcess | null = null;
  #initialization: Promise<RemoteDbClient> | null = null;

  constructor(options: DbHostManagerOptions = {}) {
    this.#entryPath = options.entryPath ?? resolveDefaultEntryPath();
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#initRequestTimeoutMs = options.initRequestTimeoutMs ?? DEFAULT_INIT_REQUEST_TIMEOUT_MS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async getDatabase(): Promise<RemoteDbClient> {
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

  async getDiagnostics(): Promise<DbHostDiagnosticsResult> {
    const result = await this.send<DbHostDiagnosticsResult>({ kind: 'diagnostics' });
    return {
      ...result,
      hostPid: this.#host?.pid ?? null,
    };
  }

  async reset(): Promise<void> {
    await this.send({ kind: 'reset' });
    this.#client = null;
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

  async send<TResult = unknown>(request: DbHostRequest): Promise<TResult> {
    const host = this.#ensureHost();
    const id = createRequestId();
    const envelope: DbHostRequestEnvelope = { id, kind: 'request', request };
    return await new Promise<TResult>((resolve, reject) => {
      const timeoutMs = this.#getRequestTimeoutMs(request);
      const timer = setTimeout(() => {
        const error = new Error(`DB host request timed out: ${request.kind}`);
        this.#pending.delete(id);
        reject(error);
        if (requiresHostTerminationOnTimeout(request)) {
          this.#terminateHost(error);
        }
      }, timeoutMs);
      this.#pending.set(id, {
        reject,
        resolve: resolve as (value: unknown) => void,
        timer,
      });
      host.postMessage(envelope);
    });
  }

  #getRequestTimeoutMs(request: DbHostRequest): number {
    if (request.kind === 'init') {
      return this.#initRequestTimeoutMs;
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
      logger.error('DB host process error', { type, location });
    });
    this.#host = host;
    return host;
  }

  async #initialize(): Promise<RemoteDbClient> {
    try {
      await this.send<DbHostInitResult>({ kind: 'init' });
    } catch (error) {
      this.#terminateHost(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
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
      query: async <TRecord = unknown>(sql: string, params?: readonly unknown[]) =>
        await this.send<DbHostQueryResult<TRecord>>({
          kind: 'query',
          sql,
          ...(params ? { params } : {}),
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
      query: payload.query,
      mode: payload.mode,
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
          transactionId,
          sql,
          ...(params ? { params } : {}),
        }),
      query: async <TRecord = unknown>(sql: string, params?: readonly unknown[]) =>
        await this.send<DbHostQueryResult<TRecord>>({
          kind: 'transaction:query',
          transactionId,
          sql,
          ...(params ? { params } : {}),
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

  #acceptResponse(message: DbHostResponseEnvelope): void {
    const pending = this.#pending.get(message.id);
    if (!pending) {
      return;
    }
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(toError(message.error));
  }

  #rejectAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
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

let defaultManager: DbHostManager | null = null;
let closingDefaultManager: Promise<void> | null = null;

export function createDbHostManager(options?: DbHostManagerOptions): DbHostManager {
  return new DefaultDbHostManager(options);
}

export function getDbHostManager(): DbHostManager {
  if (closingDefaultManager) {
    throw new Error('DB host manager is closing; wait for closeDbHostManager() to complete.');
  }
  if (!defaultManager) {
    defaultManager = createDbHostManager();
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
  closingDefaultManager = manager.close().finally(() => {
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
