import { runWithTimeout } from '@brainstrike/effect-kit';
import type { QueryProcess } from './process.js';
import {
  decodeRequest,
  decodeResponse,
  type QueryRequest,
  type QueryResponse,
  type SqliteGrepOptions,
  type SqliteGrepRows,
  type SqliteRows,
  type SqliteValue,
} from './protocol.js';

export interface OpenSqliteQueryOptions {
  readonly databasePath: string;
  readonly deadlineMs: number;
  readonly spawn: () => QueryProcess;
  readonly startupDeadlineMs: number;
}

export interface QueryOptions {
  readonly bindings?: Readonly<Record<string, SqliteValue>>;
  readonly maxRows?: number;
  readonly values?: readonly SqliteValue[];
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
          if (response.kind === 'error') {
            const error =
              pending.kind === 'open'
                ? new Error(response.message)
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
    for (const timeout of [options.deadlineMs, options.startupDeadlineMs]) {
      if (!(Number.isFinite(timeout) && timeout > 0)) {
        throw new RangeError('SQLite query deadlines must be positive finite milliseconds.');
      }
    }
    const client = new SqliteQueryClient(options.spawn(), options.deadlineMs);
    try {
      const response = await client.#call(
        { databasePath: options.databasePath, kind: 'open' },
        options.startupDeadlineMs
      );
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

  query(sql: string, options: QueryOptions = {}): Promise<SqliteRows> {
    return this.#rows({
      ...(options.bindings === undefined ? {} : { bindings: options.bindings }),
      kind: 'query',
      maxRows: options.maxRows ?? 50,
      sql,
      values: options.values ?? [],
    });
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

  describeTable(table: string): Promise<SqliteRows> {
    return this.#rows({ kind: 'describeTable', table });
  }

  listTables(): Promise<SqliteRows> {
    return this.#rows({ kind: 'listTables' });
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
    try {
      if (!(this.#hasExited || this.#killRequested)) {
        this.#process.kill();
        this.#killRequested = true;
      }
    } catch (cleanup) {
      this.#fail(
        new AggregateError(
          [reason, cleanup],
          `${reason.message} Process kill failed; ownership is retained.`,
          { cause: reason }
        )
      );
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

  async #rows(body: RequestBody): Promise<SqliteRows> {
    const response = await this.#call(body, this.#deadlineMs);
    if (response.kind !== 'rows') {
      const error = new TypeError('SQLite query returned an unexpected response.');
      this.#stop(error);
      throw error;
    }
    return response.result;
  }

  #call(body: RequestBody, timeoutMs: number): Promise<QueryResponse> {
    if (this.#terminal) {
      return Promise.reject(this.#terminal);
    }
    const id = ++this.#nextId;
    let request: QueryRequest;
    try {
      request = decodeRequest({ ...body, id });
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
      `Query exceeded its ${deadlineMs} ms deadline and its owned process was stopped. Narrow the query with WHERE, LIMIT, or an aggregate.`
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
