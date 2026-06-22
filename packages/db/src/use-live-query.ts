import { createLogger } from '@brainstrike/utils';
import type {
  LiveNamespace,
  LiveQuery,
  LiveQueryResults,
  PGliteWithLive,
} from '@electric-sql/pglite/live';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePGliteDatabase } from './db-provider.js';
import { escapePGliteLiveQueryFormatPercents } from './pglite-live-query-format.js';

export { escapePGliteLiveQueryFormatPercents } from './pglite-live-query-format.js';

const logger = createLogger('UsePGliteLiveQuery');

interface BaseLiveQueryOptions {
  /**
   * Stable cache key for memoizing query dependencies.
   * When provided, uses cheap string `===` instead of recursive `deepEqual`
   * to detect when the query should re-subscribe. Build with `makeLiveQueryKey()`.
   */
  readonly cacheKey?: string;
  /**
   * When true, drops the last delivered rows when the live query is disabled.
   * Use this for memory-sensitive views that already maintain a separate snapshot.
   */
  readonly clearOnDisable?: boolean;
  readonly compareParams?: 'json' | 'deep';
  readonly enabled?: boolean;
  readonly limit?: number;
  readonly offset?: number;
  readonly params?: readonly unknown[];
  readonly query: string;
}

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

export type UseBrainstrikeLiveQueryOptions<T> = UsePGliteLiveQueryOptions<T>;

export interface LiveQueryHookResult<T> {
  readonly error: Error | null;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
  readonly rows: T[];
}

interface LiveSubscription<T> {
  initialResults: LiveQueryResults<T>;
  refresh: (options?: { offset?: number; limit?: number }) => Promise<void>;
  unsubscribe: () => Promise<void>;
}

interface ElectronLiveQueryStartOptions {
  key?: string;
  limit?: number;
  mode: 'query' | 'incremental';
  offset?: number;
  params?: readonly unknown[] | null;
  query: string;
}

interface ElectronLiveQueryStartResult<T> {
  id: number;
  initialResults: LiveQueryResults<T>;
}

interface ElectronLiveQueryUpdate<T> {
  id: number;
  results: LiveQueryResults<T>;
}

interface ElectronLiveQueryRefreshPayload {
  id: number;
  limit?: number;
  offset?: number;
}

interface ElectronLiveBridge {
  onUpdate(callback: (payload: ElectronLiveQueryUpdate<unknown>) => void): () => void;
  refresh(payload: ElectronLiveQueryRefreshPayload): Promise<void>;
  start<T>(options: ElectronLiveQueryStartOptions): Promise<ElectronLiveQueryStartResult<T>>;
  stop(id: number): Promise<void>;
}

type LiveSource =
  | { kind: 'pglite'; live: LiveNamespace }
  | { kind: 'electron'; bridge: ElectronLiveBridge };

interface LeaderChangeSource {
  offLeaderChange?: (callback: () => void) => void;
  onLeaderChange: (callback: () => void) => (() => void) | undefined;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function areArraysDeepEqual(arrayA: readonly unknown[], arrayB: readonly unknown[]): boolean {
  if (arrayA.length !== arrayB.length) {
    return false;
  }
  for (let index = 0; index < arrayA.length; index += 1) {
    if (!deepEqual(arrayA[index], arrayB[index])) {
      return false;
    }
  }
  return true;
}

function areUint8ArraysEqual(arrayA: Uint8Array, arrayB: Uint8Array): boolean {
  if (arrayA.length !== arrayB.length) {
    return false;
  }
  for (let index = 0; index < arrayA.length; index += 1) {
    if (arrayA[index] !== arrayB[index]) {
      return false;
    }
  }
  return true;
}

function areObjectsDeepEqual(
  objectA: Record<string, unknown>,
  objectB: Record<string, unknown>
): boolean {
  const keysA = Object.keys(objectA);
  const keysB = Object.keys(objectB);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (const key of keysA) {
    if (!(Object.hasOwn(objectB, key) && deepEqual(objectA[key], objectB[key]))) {
      return false;
    }
  }
  return true;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (!(isObjectLike(a) && isObjectLike(b))) {
    return false;
  }
  if (a.constructor !== b.constructor) {
    return false;
  }

  if (Array.isArray(a)) {
    return Array.isArray(b) && areArraysDeepEqual(a, b);
  }
  if (a instanceof Date) {
    return b instanceof Date && a.getTime() === b.getTime();
  }
  if (a instanceof Uint8Array) {
    return b instanceof Uint8Array && areUint8ArraysEqual(a, b);
  }
  if (a instanceof RegExp) {
    return b instanceof RegExp && a.source === b.source && a.flags === b.flags;
  }

  return areObjectsDeepEqual(a, b);
}

/**
 * Build a stable cache key from serializable query arguments.
 * When passed as `cacheKey` to `usePGliteLiveQuery`, the hook uses cheap
 * string `===` comparison instead of recursive `deepEqual` on every render.
 *
 * @example
 * ```ts
 * const key = makeLiveQueryKey('files', collectionId, page);
 * const { rows } = usePGliteLiveQuery({ query, params, cacheKey: key });
 * ```
 */
export function makeLiveQueryKey(...args: readonly unknown[]): string {
  return JSON.stringify(args);
}

function useStableParams<T>(value: T, strategy: 'json' | 'deep'): T {
  const ref = useRef<T>(value);
  const keyRef = useRef<string>('');

  if (strategy === 'json') {
    let nextKey: string;
    try {
      nextKey = JSON.stringify(value) ?? ''; // undefined/Symbol/Function → ''
    } catch {
      // BigInt or other non-serializable types — fall back to deepEqual
      if (!deepEqual(value, ref.current)) {
        ref.current = value;
      }
      keyRef.current = '\0'; // Sentinel JSON.stringify can never produce
      return ref.current;
    }
    // Note: null ≡ undefined inside arrays (both serialize to "[null]")
    if (nextKey !== keyRef.current) {
      keyRef.current = nextKey;
      ref.current = value;
    }
  } else if (!deepEqual(value, ref.current)) {
    ref.current = value;
  }

  return ref.current;
}

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

function getLeaderChangeSource(
  db: ReturnType<typeof usePGliteDatabase>
): LeaderChangeSource | null {
  const raw = (db as { raw?: unknown } | null)?.raw;
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const candidate = raw as { offLeaderChange?: unknown; onLeaderChange?: unknown };
  if (typeof candidate.onLeaderChange !== 'function') {
    return null;
  }
  const onLeaderChange = candidate.onLeaderChange as (
    this: typeof raw,
    callback: () => void
  ) => (() => void) | undefined;
  const source: LeaderChangeSource = {
    onLeaderChange: (callback) => onLeaderChange.call(raw, callback),
  };
  if (typeof candidate.offLeaderChange === 'function') {
    const offLeaderChange = candidate.offLeaderChange as (
      this: typeof raw,
      callback: () => void
    ) => void;
    source.offLeaderChange = (callback) => offLeaderChange.call(raw, callback);
  }
  return source;
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
    handle = await live.incrementalQuery(
      escapePGliteLiveQueryFormatPercents(options.query, params),
      params ?? undefined,
      options.key
    );
  } else {
    const queryOptions: {
      query: string;
      params?: unknown[] | null;
      offset?: number;
      limit?: number;
    } = {
      query: escapePGliteLiveQueryFormatPercents(options.query, params),
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
    query: escapePGliteLiveQueryFormatPercents(options.query, options.params),
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
  const [leaderRevision, setLeaderRevision] = useState(0);
  const hasCacheKey = options.cacheKey !== undefined;
  // When cacheKey is provided, skip expensive deep/JSON comparison — the caller
  // guarantees that cacheKey changes iff the query deps change.
  const stableParams = useStableParams(
    hasCacheKey ? undefined : options.params,
    options.compareParams ?? 'json'
  );
  // Resolve effective params: use raw params when cacheKey is provided (comparison
  // is driven by the cacheKey string), otherwise use the stabilised reference.
  const effectiveParams = hasCacheKey ? options.params : stableParams;
  // Single reactive dependency for params: when cacheKey is provided, changes to
  // this string trigger re-subscription (cheap ===). When absent, the stabilised
  // params reference drives re-subscription via useStableParams.
  const paramsDep: string | readonly unknown[] | undefined = hasCacheKey
    ? options.cacheKey
    : stableParams;
  // Keep a ref so the effect closure always reads current params.
  const effectiveParamsRef = useRef(effectiveParams);
  effectiveParamsRef.current = effectiveParams;
  const [rawRows, setRawRows] = useState<T[]>([]);
  const [loading, setLoading] = useState<boolean>(Boolean(options.enabled ?? true));
  const [error, setError] = useState<Error | null>(null);
  const refreshRef = useRef<() => Promise<void>>(noopAsync);

  const mode: 'query' | 'incremental' = options.mode ?? 'query';
  const requiresKey = mode === 'incremental';
  const hasKey = !requiresKey || typeof options.key === 'string';
  const enabled = Boolean(options.enabled ?? true) && Boolean(source) && (!requiresKey || hasKey);
  const select = options.select;

  useEffect(() => {
    const leaderSource = getLeaderChangeSource(db);
    if (!leaderSource) {
      return;
    }
    const listener = () => {
      setLeaderRevision((revision) => revision + 1);
    };
    const unsubscribe = leaderSource.onLeaderChange(listener);
    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
        return;
      }
      if (leaderSource.offLeaderChange) {
        leaderSource.offLeaderChange(listener);
        return;
      }
      logger.warn('PGlite leader-change listener could not be removed');
    };
  }, [db]);

  // biome-ignore lint/plugin: Live query subscription management - async data with cleanup
  // biome-ignore lint/correctness/useExhaustiveDependencies: paramsDep intentionally drives re-subscription timing via the dep array — the effect reads actual params from effectiveParamsRef
  useEffect(() => {
    let cancelled = false;
    let subscription: LiveSubscription<T> | null = null;

    if (!enabled) {
      if (options.clearOnDisable) {
        setRawRows([]);
      }
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
      setRawRows(results.rows as T[]);
    };

    setLoading(true);
    setError(null);

    const currentParams = effectiveParamsRef.current;
    const normalizedOptions: InternalLiveQueryOptions = {
      query: options.query,
      mode,
      ...(currentParams === undefined ? {} : { params: currentParams }),
      ...(options.offset === undefined ? {} : { offset: options.offset }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
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
        setRawRows(result.initialResults.rows as T[]);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        const normalized = err instanceof Error ? err : new Error(String(err));
        setError(normalized);
        setRawRows([]);
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
    leaderRevision,
    paramsDep,
    options.query,
    // select intentionally omitted to prevent re-subscription
    source,
  ]);

  const refresh = useCallback(async () => {
    await refreshRef.current();
  }, []);

  const rows = useMemo(() => (select ? select(rawRows) : rawRows) as T[], [select, rawRows]);

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

export function useBrainstrikeLiveQuery<T = Record<string, unknown>>(
  options: UseBrainstrikeLiveQueryOptions<T>
): LiveQueryHookResult<T> {
  return usePGliteLiveQuery(options);
}
