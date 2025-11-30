import type {
  LiveNamespace,
  LiveQuery,
  LiveQueryResults,
  PGliteWithLive,
} from '@electric-sql/pglite/live';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePGliteDatabase } from './db-provider.js';

type BaseLiveQueryOptions = {
  readonly query: string;
  readonly params?: readonly unknown[];
  readonly offset?: number;
  readonly limit?: number;
  readonly enabled?: boolean;
};

type IncrementalOptions = BaseLiveQueryOptions & {
  readonly mode: 'incremental';
  readonly key: string;
};

type StandardOptions = BaseLiveQueryOptions & {
  readonly mode?: 'query';
  readonly key?: never;
};

type InternalLiveQueryOptions = BaseLiveQueryOptions & {
  readonly mode: 'query' | 'incremental';
  readonly key?: string;
};

export type UsePGliteLiveQueryOptions<T> = (IncrementalOptions | StandardOptions) & {
  readonly select?: (rows: T[]) => T[];
};

export type LiveQueryHookResult<T> = {
  readonly rows: T[];
  readonly loading: boolean;
  readonly error: Error | null;
  readonly refresh: () => Promise<void>;
};

type LiveSubscription<T> = {
  initialResults: LiveQueryResults<T>;
  refresh: (options?: { offset?: number; limit?: number }) => Promise<void>;
  unsubscribe: () => Promise<void>;
};

type ElectronLiveQueryStartOptions = {
  mode: 'query' | 'incremental';
  query: string;
  params?: readonly unknown[] | null;
  key?: string;
  offset?: number;
  limit?: number;
};

type ElectronLiveQueryStartResult<T> = {
  id: number;
  initialResults: LiveQueryResults<T>;
};

type ElectronLiveQueryUpdate<T> = {
  id: number;
  results: LiveQueryResults<T>;
};

type ElectronLiveQueryRefreshPayload = {
  id: number;
  offset?: number;
  limit?: number;
};

type ElectronLiveBridge = {
  start<T>(options: ElectronLiveQueryStartOptions): Promise<ElectronLiveQueryStartResult<T>>;
  stop(id: number): Promise<void>;
  refresh(payload: ElectronLiveQueryRefreshPayload): Promise<void>;
  onUpdate(callback: (payload: ElectronLiveQueryUpdate<unknown>) => void): () => void;
};

type LiveSource =
  | { kind: 'pglite'; live: LiveNamespace }
  | { kind: 'electron'; bridge: ElectronLiveBridge };

const noopAsync = async () => {};

function getElectronLiveBridge(): ElectronLiveBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const electronAPI = (
    window as typeof window & {
      electronAPI?: { dbLive?: ElectronLiveBridge };
    }
  ).electronAPI;
  return electronAPI?.dbLive ?? null;
}

function getLiveNamespace(db: ReturnType<typeof usePGliteDatabase>): LiveNamespace | null {
  const raw = (db as { raw?: unknown } | null)?.raw;
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if ('live' in raw && raw.live && typeof (raw as PGliteWithLive).live === 'object') {
    return (raw as PGliteWithLive).live;
  }
  return null;
}

function resolveLiveSource(db: ReturnType<typeof usePGliteDatabase>): LiveSource | null {
  const directLive = getLiveNamespace(db);
  if (directLive) {
    return { kind: 'pglite', live: directLive };
  }
  const bridge = getElectronLiveBridge();
  if (bridge) {
    return { kind: 'electron', bridge };
  }
  return null;
}

async function subscribeViaPGlite<T>(
  live: LiveNamespace,
  options: InternalLiveQueryOptions,
  onUpdate: (results: LiveQueryResults<T>) => void
): Promise<LiveSubscription<T>> {
  const params = options.params ? [...options.params] : null;
  let handle: LiveQuery<T>;
  if (options.mode === 'incremental') {
    if (!options.key) {
      throw new Error('Live incremental queries require a key column');
    }
    handle = await live.incrementalQuery(options.query, params ?? undefined, options.key);
  } else {
    const queryOptions: {
      query: string;
      params?: unknown[] | null;
      offset?: number;
      limit?: number;
    } = {
      query: options.query,
      params,
    };
    if (options.offset !== undefined) {
      queryOptions.offset = options.offset;
    }
    if (options.limit !== undefined) {
      queryOptions.limit = options.limit;
    }
    handle = await live.query(queryOptions);
  }

  const listener = (results: LiveQueryResults<T>) => {
    onUpdate(results);
  };

  handle.subscribe(listener);

  return {
    initialResults: handle.initialResults,
    refresh: async (refreshOptions) => {
      await handle.refresh(refreshOptions);
    },
    unsubscribe: async () => {
      await handle.unsubscribe(listener);
    },
  };
}

async function subscribeViaElectron<T>(
  bridge: ElectronLiveBridge,
  options: InternalLiveQueryOptions,
  onUpdate: (results: LiveQueryResults<T>) => void
): Promise<LiveSubscription<T>> {
  const startPayload: ElectronLiveQueryStartOptions = {
    mode: options.mode,
    query: options.query,
    params: options.params ?? null,
  };
  if (options.key) {
    startPayload.key = options.key;
  }
  if (options.offset !== undefined) {
    startPayload.offset = options.offset;
  }
  if (options.limit !== undefined) {
    startPayload.limit = options.limit;
  }

  const startResult = await bridge.start<T>(startPayload);

  const unsubscribeUpdates = bridge.onUpdate((payload) => {
    if (payload.id !== startResult.id) {
      return;
    }
    onUpdate(payload.results as LiveQueryResults<T>);
  });

  return {
    initialResults: startResult.initialResults,
    refresh: async (refreshOptions) => {
      const refreshPayload: ElectronLiveQueryRefreshPayload = { id: startResult.id };
      if (refreshOptions?.offset !== undefined) {
        refreshPayload.offset = refreshOptions.offset;
      }
      if (refreshOptions?.limit !== undefined) {
        refreshPayload.limit = refreshOptions.limit;
      }
      await bridge.refresh(refreshPayload);
    },
    unsubscribe: async () => {
      unsubscribeUpdates();
      await bridge.stop(startResult.id);
    },
  };
}

async function subscribeToLiveSource<T>(
  source: LiveSource,
  options: InternalLiveQueryOptions,
  onUpdate: (results: LiveQueryResults<T>) => void
): Promise<LiveSubscription<T>> {
  if (source.kind === 'pglite') {
    return subscribeViaPGlite(source.live, options, onUpdate);
  }
  return subscribeViaElectron(source.bridge, options, onUpdate);
}

export function usePGliteLiveQuery<T = Record<string, unknown>>(
  options: UsePGliteLiveQueryOptions<T>
): LiveQueryHookResult<T> {
  const db = usePGliteDatabase();
  const source = useMemo(() => resolveLiveSource(db), [db]);
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState<boolean>(Boolean(options.enabled ?? true));
  const [error, setError] = useState<Error | null>(null);
  const refreshRef = useRef<() => Promise<void>>(noopAsync);

  const mode: 'query' | 'incremental' = options.mode ?? 'query';
  const requiresKey = mode === 'incremental';
  const hasKey = !requiresKey || typeof options.key === 'string';
  const enabled = Boolean(options.enabled ?? true) && Boolean(source) && (!requiresKey || hasKey);

  // biome-ignore lint/plugin: Live query subscription management - async data with cleanup
  useEffect(() => {
    let cancelled = false;
    let subscription: LiveSubscription<T> | null = null;

    if (!enabled) {
      setRows([]);
      setError(null);
      setLoading(false);
      refreshRef.current = noopAsync;
      return () => {
        cancelled = true;
      };
    }

    const handleUpdate = (results: LiveQueryResults<T>) => {
      if (cancelled) {
        return;
      }
      setRows((options.select ? options.select(results.rows) : results.rows) as T[]);
    };

    setLoading(true);
    setError(null);

    const normalizedOptions: InternalLiveQueryOptions = {
      query: options.query,
      mode,
      ...(options.params !== undefined ? { params: options.params } : {}),
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.key ? { key: options.key } : {}),
    };

    void subscribeToLiveSource<T>(source as LiveSource, normalizedOptions, handleUpdate)
      .then((result) => {
        if (cancelled) {
          void result.unsubscribe();
          return;
        }
        subscription = result;
        refreshRef.current = async () => {
          await result.refresh();
        };
        setRows(
          (options.select
            ? options.select(result.initialResults.rows)
            : result.initialResults.rows) as T[]
        );
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        const normalized = err instanceof Error ? err : new Error(String(err));
        setError(normalized);
        setRows([]);
        setLoading(false);
        refreshRef.current = noopAsync;
      });

    return () => {
      cancelled = true;
      refreshRef.current = noopAsync;
      if (subscription) {
        void subscription.unsubscribe();
      }
    };
  }, [
    enabled,
    mode,
    options.key,
    options.limit,
    options.offset,
    options.params,
    options.query,
    options.select,
    source,
  ]);

  const refresh = useCallback(async () => {
    await refreshRef.current();
  }, []);

  return useMemo(
    () => ({
      rows,
      loading,
      error,
      refresh,
    }),
    [rows, loading, error, refresh]
  );
}
