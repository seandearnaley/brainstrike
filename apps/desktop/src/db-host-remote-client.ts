import type { DbHostQueryResult, DbHostRequest } from './db-host-protocol';

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
  readonly maintenance: {
    readonly exec: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
  };
  readonly transaction: <TResult>(
    fn: (tx: RemoteDbTransaction) => Promise<TResult>
  ) => Promise<TResult>;
}

/** What a live query needs from the manager that started it. */
export interface RemoteLiveQueryOwner {
  readonly send: (request: DbHostRequest) => Promise<unknown>;
  readonly unregisterLiveQuery: (liveId: string) => void;
}

export class RemoteLiveQuery<TRecord = unknown> implements RemoteDbLiveQuery<TRecord> {
  readonly #listeners = new Set<(results: DbHostQueryResult<TRecord>) => void>();
  readonly #manager: RemoteLiveQueryOwner;
  readonly #liveId: string;
  #failure: Error | null = null;
  #initialResults: DbHostQueryResult<TRecord>;
  #stopped = false;

  constructor(
    manager: RemoteLiveQueryOwner,
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
