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
import { CHILD_SIGNAL_GRACE_MS } from '@brainstrike/state-store';
import {
  createMessageConnection,
  Message,
  type MessageConnection,
  ResponseError,
} from 'vscode-jsonrpc/node';
import { EndpointMessageReader, EndpointMessageWriter } from './endpoint-transport.ts';
import type { QueryProcess } from './process.ts';
import {
  decodeErrorData,
  type QueryMethod,
  type QueryResult,
  queryMethods,
  type SqliteGrepOptions,
  type SqliteGrepRows,
} from './protocol.ts';
import { SqliteRuntimeRefusedError } from './runtime-refusal.ts';

export interface OpenSqliteQueryOptions {
  readonly databasePath: string;
  /**
   * R5(a): the bound of one read the user waits on, refused as `SqliteQueryDeadlineError` with
   * the read's own process stopped. Absent, a read has no deadline (background work, lifecycle
   * R2): the process's exit is its only end.
   */
  readonly deadlineMs?: number | undefined;
  /** The owner's log of an exit still pending `CHILD_SIGNAL_GRACE_MS` after the kill (ADR-0030). */
  readonly onSlowExit?: ((elapsedMs: number) => void) | undefined;
  readonly spawn: () => QueryProcess;
  /** R5(a): the bound of the startup such a read waits on, as `deadlineMs`. Absent, none. */
  readonly startupDeadlineMs?: number | undefined;
}

export interface OpenNativeCoverageOptions extends Omit<OpenSqliteQueryOptions, 'databasePath'> {
  readonly authority: CoverageAuthority;
}

/**
 * One read-only query process over a `vscode-jsonrpc` connection. The first terminal error (a
 * deadline, a protocol fault, the owner's close or the process's exit) rejects every request in
 * flight and every later one; a reply that arrives after it changes nothing. Listeners stay
 * attached until the exit and detach once.
 */
export class SqliteQueryClient {
  readonly #process: QueryProcess;
  readonly #connection: MessageConnection;
  readonly #deadlineMs: number | undefined;
  readonly #onSlowExit: ((elapsedMs: number) => void) | undefined;
  /** Rejected once, with the terminal error, so every request racing it settles with that error. */
  readonly #terminated = Promise.withResolvers<never>();
  readonly #exited: Promise<void>;
  readonly #detach: (() => void)[] = [];
  #terminal: Error | undefined;
  #settled = false;
  #hasExited = false;
  #killRequested = false;

  private constructor(
    process: QueryProcess,
    deadlineMs: number | undefined,
    onSlowExit: ((elapsedMs: number) => void) | undefined
  ) {
    this.#process = process;
    this.#deadlineMs = deadlineMs;
    this.#onSlowExit = onSlowExit;
    this.#terminated.promise.catch(() => undefined);
    const reader = new EndpointMessageReader();
    // The vendor drops a reply whose id it never sent without reporting it (an unknown id is
    // not even logged), and a read with no deadline would then wait forever. So the ids sent
    // are tracked here, and a reply to any other id is a protocol fault.
    const sent = new Set<number | string | null>();
    this.#connection = createMessageConnection(
      reader,
      new EndpointMessageWriter((message) => {
        if (Message.isRequest(message)) {
          sent.add(message.id);
        }
        process.postMessage(message);
      })
    );
    this.#connection.onError(([error]) => {
      this.#stop(error);
    });
    this.#connection.listen();
    this.#exited = new Promise((resolve) => {
      this.#detach.push(
        process.onExit(() => {
          this.#hasExited = true;
          this.#fail(this.#terminal ?? new SqliteQueryProcessExitedError());
          this.#connection.dispose();
          for (const detach of this.#detach.splice(0)) {
            detach();
          }
          resolve();
        })
      );
    });
    this.#detach.push(
      process.onMessage((message) => {
        const reply = message as Message;
        if (Message.isResponse(reply) && !sent.delete(reply.id)) {
          this.#stop(new TypeError('SQLite query process replied to a request it was not sent.'));
          return;
        }
        reader.deliver(message);
      })
    );
    this.#detach.push(
      process.onError((error) => {
        this.#stop(error);
      })
    );
  }

  static async open(options: OpenSqliteQueryOptions): Promise<SqliteQueryClient> {
    return SqliteQueryClient.#open(options, 'open', { databasePath: options.databasePath });
  }

  static async openNativeCoverage(options: OpenNativeCoverageOptions): Promise<SqliteQueryClient> {
    const params = { authority: options.authority };
    // Measured before a process exists: an oversized authority spawns nothing.
    assertCoverageAuthorityBound(params);
    return SqliteQueryClient.#open(options, 'openNativeCoverage', params);
  }

  static async #open(
    options: Omit<OpenSqliteQueryOptions, 'databasePath'>,
    method: 'open' | 'openNativeCoverage',
    params: unknown
  ): Promise<SqliteQueryClient> {
    for (const timeout of [options.deadlineMs, options.startupDeadlineMs]) {
      if (timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0)) {
        throw new RangeError('SQLite query deadlines must be positive finite milliseconds.');
      }
    }
    const client = new SqliteQueryClient(options.spawn(), options.deadlineMs, options.onSlowExit);
    try {
      await client.#call(method, params, options.startupDeadlineMs);
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

  nativeCoverage(requests: readonly ScopedCoverageRequest[]): Promise<readonly ScopedCoverage[]> {
    return this.#call('nativeCoverage', { requests }, this.#deadlineMs);
  }

  grep(options: SqliteGrepOptions): Promise<SqliteGrepRows> {
    return this.#call('grep', options, this.#deadlineMs);
  }

  /**
   * Closing a query process is its kill (it holds only read-only connections), then the exit,
   * joined however long it takes (R5(b)); a late exit is reported, never abandoned. A refused
   * kill throws, and the live process stays owned for a retry.
   */
  async close(): Promise<void> {
    this.#fail(this.#terminal ?? new Error('SQLite query client is closed.'));
    if (!(this.#hasExited || this.#killRequested)) {
      this.#process.kill();
      this.#killRequested = true;
    }
    if (this.#hasExited) {
      return;
    }
    const late = setTimeout(() => this.#onSlowExit?.(CHILD_SIGNAL_GRACE_MS), CHILD_SIGNAL_GRACE_MS);
    try {
      await this.#exited;
    } finally {
      clearTimeout(late);
    }
  }

  /** Make `reason` terminal (unless one already is), kill the process once, and return the terminal error. */
  #stop(reason: Error): Error {
    this.#terminal ??= reason;
    try {
      if (!(this.#hasExited || this.#killRequested)) {
        this.#process.kill();
        this.#killRequested = true;
      }
    } catch (cleanup) {
      this.#terminal = new AggregateError(
        [reason, cleanup],
        `${reason.message} Process kill failed; ownership is retained.`,
        { cause: reason }
      );
    }
    return this.#fail(this.#terminal);
  }

  #fail(reason: Error): Error {
    this.#terminal ??= reason;
    if (!this.#settled) {
      this.#settled = true;
      this.#terminated.reject(this.#terminal);
    }
    return this.#terminal;
  }

  /** A refusal the process answered with, typed for its caller; anything else is a protocol fault. */
  #refusal(method: QueryMethod, error: unknown): Error {
    if (error instanceof ResponseError) {
      let data: ReturnType<typeof decodeErrorData> | undefined;
      try {
        data = decodeErrorData(error.data);
      } catch {
        data = undefined;
      }
      if (data?.kind === 'coverage') {
        return new IndexerError(data.fault.code, data.fault.message);
      }
      if (data?.kind === 'engine') {
        if (method !== 'open') {
          return new SqliteQueryInputError(error.message, data.name);
        }
        return data.name === 'SqliteRuntimeRefusedError'
          ? new SqliteRuntimeRefusedError(error.message)
          : new Error(error.message);
      }
    }
    return this.#stop(error instanceof Error ? error : new Error(String(error)));
  }

  #call<M extends QueryMethod>(
    method: M,
    input: unknown,
    timeoutMs: number | undefined
  ): Promise<QueryResult<M>> {
    if (this.#terminal) {
      return Promise.reject(this.#terminal);
    }
    let params: unknown;
    try {
      params = queryMethods[method].params(input);
    } catch (error) {
      return Promise.reject(error);
    }
    const reply = async (): Promise<QueryResult<M>> => {
      let value: unknown;
      try {
        value = await Promise.race([
          this.#connection.sendRequest(method, params),
          this.#terminated.promise,
        ]);
      } catch (error) {
        throw this.#terminal ?? this.#refusal(method, error);
      }
      try {
        return queryMethods[method].result(value) as QueryResult<M>;
      } catch (error) {
        throw this.#stop(error instanceof Error ? error : new Error(String(error)));
      }
    };
    return timeoutMs === undefined
      ? reply()
      : runWithTimeout(reply, {
          onTimeout: () => this.#stop(new SqliteQueryDeadlineError(timeoutMs)),
          timeoutMs,
        });
  }
}

export class SqliteQueryDeadlineError extends Error {
  constructor(deadlineMs: number) {
    super(
      `SQLite index read exceeded its ${deadlineMs} ms deadline and its owned process was stopped.`
    );
    this.name = 'SqliteQueryDeadlineError';
  }
}

/**
 * The query process exited while its owner had not asked it to: a crash, or a signal sent to the
 * owner's whole process group. Every request it had admitted, and every later one, rejects with
 * this one error. A stop the owner asked for keeps its own reason instead.
 */
export class SqliteQueryProcessExitedError extends Error {
  constructor() {
    super('SQLite query process exited.');
    this.name = 'SqliteQueryProcessExitedError';
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
