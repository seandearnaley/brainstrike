declare module '@electric-sql/pglite/live' {
  export interface LiveQueryResults<T = Record<string, unknown>> {
    rows: T[];
    fields?: Array<{ name: string; dataTypeID: number }>;
    totalCount?: number;
    offset?: number;
    limit?: number;
  }

  export interface LiveQuery<T = Record<string, unknown>> {
    initialResults: LiveQueryResults<T>;
    subscribe(callback: (results: LiveQueryResults<T>) => void): void;
    unsubscribe(callback?: (results: LiveQueryResults<T>) => void): Promise<void>;
    refresh(options?: { offset?: number; limit?: number }): Promise<void>;
  }

  export interface LiveNamespace {
    query<T = Record<string, unknown>>(options: {
      query: string;
      params?: unknown[] | null;
      offset?: number;
      limit?: number;
    }): Promise<LiveQuery<T>>;
    query<T = Record<string, unknown>>(
      query: string,
      params?: unknown[] | null,
      callback?: (results: LiveQueryResults<T>) => void
    ): Promise<LiveQuery<T>>;
    incrementalQuery<T = Record<string, unknown>>(options: {
      query: string;
      params?: unknown[] | null;
      key: string;
    }): Promise<LiveQuery<T>>;
    incrementalQuery<T = Record<string, unknown>>(
      query: string,
      params: unknown[] | null | undefined,
      key: string,
      callback?: (results: LiveQueryResults<T>) => void
    ): Promise<LiveQuery<T>>;
  }

  export type PGliteWithLive = {
    live: LiveNamespace;
  };

  export const live: {
    name: string;
  };
}
