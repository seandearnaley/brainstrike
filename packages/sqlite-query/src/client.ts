import { runWithTimeout } from '@brainstrike/effect-kit';
import {
  IndexerError,
  type ScopedCoverage,
  type ScopedCoverageRequest,
} from '@brainstrike/indexer';
import {
  assertCoverageAuthorityBound,
  type CoverageAuthority,
} from '@brainstrike/indexer/coverage-reader';
import type { QueryProcess } from './process.js';
import {
  decodeRequest,
  decodeResponse,
  type QueryRequest,
  type QueryResponse,
  type SqliteGrepOptions,
  type SqliteGrepRows,
} from './protocol.js';
import { SqliteRuntimeRefusedError } from './runtime-refusal.js';

/** A startup failure rebuilt from the query process's reply; a runtime refusal keeps its type. */
function startupError(reply: { readonly message: string; readonly name: string }): Error {
  return reply.name === 'SqliteRuntimeRefusedError'
    ? new SqliteRuntimeRefusedError(reply.message)
    : new Error(reply.message);
}

export interface OpenSqliteQueryOptions {
  readonly databasePath: string;
  readonly deadlineMs: number;
  readonly spawn: () => QueryProcess;
  readonly startupDeadlineMs: number;
}

export interface OpenNativeCoverageOptions extends Omit<OpenSqliteQueryOptions, 'databasePath'> {
  readonly authority: CoverageAuthority;
}

export class SqliteQueryClient {
  readonly #process: QueryProcess;
  readonly #deadlineMs: number;
  readonly #pending = new Map<
    number,
    {
      readonly resolve: (response: QueryResponse) => void;
      readonly reject: (reason: unknown) => void;
      readonly kind: QueryRequest['kind'];
    }
  >();
  readonly #exited: Promise<void>;
  readonly #detach: (() => void)[] = [];
  #nextId = 0;
  #terminal: Error | undefined;
  #hasExited = false;
  #killRequested = false;

  private constructor(process: QueryProcess, deadlineMs: number) {
    this.#process = process;
    this.#deadlineMs = deadlineMs;
    this.#exited = new Promise((resolve) => {
      this.#detach.push(
        process.onExit(() => {
          this.#hasExited = true;
          this.#fail(this.#terminal ?? new Error('SQLite query process exited.'));
          for (const detach of this.#detach.splice(0)) {
            detach();
          }
          resolve();
        })
      );
    });
    this.#detach.push(
      process.onMessage((message) => {
        try {
          const response = decodeResponse(message);
          const pending = this.#pending.get(response.id);
          if (!pending) {
            throw new TypeError('SQLite query process replied with an unknown request id.');
          }
          this.#pending.delete(response.id);
          if (response.kind === 'nativeCoverageError') {
            if (pending.kind !== 'native-coverage' && pending.kind !== 'open-native-coverage') {
              throw new TypeError('Native coverage error replied to a grep request.');
            }
            pending.reject(new IndexerError(response.error.code, response.error.message));
            return;
          }
          if (response.kind === 'error') {
            const error =
              pending.kind === 'open'
                ? startupError(response)
                : new SqliteQueryInputError(response.message, response.name);
            pending.reject(error);
            return;
          }
          pending.resolve(response);
        } catch (error) {
          this.#stop(error instanceof Error ? error : new Error(String(error)));
        }
      })
    );
    this.#detach.push(
      process.onError((error) => {
        this.#stop(error);
      })
    );
  }

  static async open(options: OpenSqliteQueryOptions): Promise<SqliteQueryClient> {
    return SqliteQueryClient.#open(options, { databasePath: options.databasePath, kind: 'open' });
  }

  static async openNativeCoverage(options: OpenNativeCoverageOptions): Promise<SqliteQueryClient> {
    return SqliteQueryClient.#open(options, {
      authority: options.authority,
      kind: 'open-native-coverage',
    });
  }

  static async #open(
    options: Omit<OpenSqliteQueryOptions, 'databasePath'>,
    body: RequestBody
  ): Promise<SqliteQueryClient> {
    for (const timeout of [options.deadlineMs, options.startupDeadlineMs]) {
      if (!(Number.isFinite(timeout) && timeout > 0)) {
        throw new RangeError('SQLite query deadlines must be positive finite milliseconds.');
      }
    }
    const client = new SqliteQueryClient(options.spawn(), options.deadlineMs);
    try {
      const response = await client.#call(body, options.startupDeadlineMs);
      if (response.kind !== 'ready') {
        throw new TypeError('SQLite query startup returned an unexpected response.');
      }
      return client;
    } catch (error) {
      try {
        await client.close();
      } catch (cleanup) {
        throw new SqliteQueryStartupCleanupError(client, error, cleanup);
      }
      throw error;
    }
  }

  async nativeCoverage(
    requests: readonly ScopedCoverageRequest[]
  ): Promise<readonly ScopedCoverage[]> {
    const response = await this.#call({ kind: 'native-coverage', requests }, this.#deadlineMs);
    if (response.kind !== 'nativeCoverage') {
      const error = new TypeError('Native coverage returned an unexpected response.');
      this.#stop(error);
      throw error;
    }
    return response.result;
  }

  async grep(options: SqliteGrepOptions): Promise<SqliteGrepRows> {
    const response = await this.#call({ kind: 'grep', ...options }, this.#deadlineMs);
    if (response.kind !== 'grepRows') {
      const error = new TypeError('SQLite grep returned an unexpected response.');
      this.#stop(error);
      throw error;
    }
    return response.result;
  }

  async close(): Promise<void> {
    this.#fail(this.#terminal ?? new Error('SQLite query client is closed.'));
    if (!(this.#hasExited || this.#killRequested)) {
      this.#process.kill();
      this.#killRequested = true;
    }
    await runWithTimeout(() => this.#exited, {
      onTimeout: () =>
        new Error('Owned SQLite query process has not exited after kill; ownership is retained.'),
      timeoutMs: 5000,
    });
  }

  #stop(reason: Error): void {
    this.#terminal ??= reason;
    try {
      if (!(this.#hasExited || this.#killRequested)) {
        this.#process.kill();
        this.#killRequested = true;
      }
    } catch (cleanup) {
      const failure = new AggregateError(
        [reason, cleanup],
        `${reason.message} Process kill failed; ownership is retained.`,
        { cause: reason }
      );
      this.#terminal = failure;
      this.#fail(failure);
      return;
    }
    this.#fail(reason);
  }

  #fail(reason: Error): void {
    this.#terminal ??= reason;
    for (const pending of this.#pending.values()) {
      pending.reject(this.#terminal);
    }
    this.#pending.clear();
  }

  #call(body: RequestBody, timeoutMs: number): Promise<QueryResponse> {
    if (this.#terminal) {
      return Promise.reject(this.#terminal);
    }
    const id = ++this.#nextId;
    let request: QueryRequest;
    try {
      request = decodeRequest({ ...body, id });
      if (request.kind === 'open-native-coverage') {
        assertCoverageAuthorityBound(request);
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return runWithTimeout(
      () =>
        new Promise<QueryResponse>((resolve, reject) => {
          this.#pending.set(id, { kind: request.kind, reject, resolve });
          try {
            this.#process.postMessage(request);
          } catch (error) {
            this.#stop(error instanceof Error ? error : new Error(String(error)));
          }
        }),
      {
        onTimeout: () => {
          this.#stop(new SqliteQueryDeadlineError(timeoutMs));
          return this.#terminal;
        },
        timeoutMs,
      }
    ).finally(() => {
      this.#pending.delete(id);
    });
  }
}

type RequestBody = {
  [Kind in QueryRequest['kind']]: Omit<Extract<QueryRequest, { kind: Kind }>, 'id'>;
}[QueryRequest['kind']];

export class SqliteQueryDeadlineError extends Error {
  constructor(deadlineMs: number) {
    super(
      `SQLite index read exceeded its ${deadlineMs} ms deadline and its owned process was stopped.`
    );
    this.name = 'SqliteQueryDeadlineError';
  }
}

export class SqliteQueryInputError extends Error {
  readonly engineErrorName: string;

  constructor(message: string, engineErrorName: string) {
    super(message);
    this.name = 'SqliteQueryInputError';
    this.engineErrorName = engineErrorName;
  }
}

/** Failed acquisition still returns its resource owner for explicit cleanup. */
export class SqliteQueryStartupCleanupError extends AggregateError {
  readonly owner: SqliteQueryClient;

  constructor(owner: SqliteQueryClient, startup: unknown, cleanup: unknown) {
    super([startup, cleanup], 'SQLite query startup and cleanup failed; ownership is retained.', {
      cause: startup,
    });
    this.name = 'SqliteQueryStartupCleanupError';
    this.owner = owner;
  }
}
