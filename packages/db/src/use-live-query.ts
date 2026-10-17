import { createLogger } from '@brainstrike/logging';
import type {
  LiveNamespace,
  LiveQuery,
  LiveQueryResults,
  PGliteWithLive,
} from '@electric-sql/pglite/live';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  measureDatabaseQuery,
  recordDatabaseLiveSubscriptionEnded,
  recordDatabaseLiveSubscriptionStarted,
  recordDatabaseLiveUpdate,
} from './database-query-telemetry.js';
import type { LiveQueryDrainRegistration } from './db-reset-drain.js';
import { escapePGliteLiveQueryFormatPercents } from './pglite-live-query-format.js';
import { useLiveQueryDrainRegistry, usePGliteDatabase } from './use-db.js';

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

export interface LiveQueryHookResult<T> {
  readonly error: Error | null;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
  readonly rows: T[];
  /**
   * Whether `rows` were delivered for the CURRENT query: the same source,
   * query, params and window. It stays true while a re-subscribe of that same
   * query loads (a PGlite leader change keeps the previous rows), and turns
   * false on the very render that changes the query, before its effect reports
   * `loading`. False before the first delivery, after an error and while
   * disabled (BST-1792).
   */
  readonly rowsMatchQuery: boolean;
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
  onUpdate: (callback: (payload: ElectronLiveQueryUpdate<unknown>) => void) => () => void;
  refresh: (payload: ElectronLiveQueryRefreshPayload) => Promise<void>;
  start: <T>(options: ElectronLiveQueryStartOptions) => Promise<ElectronLiveQueryStartResult<T>>;
  stop: (id: number) => Promise<void>;
}

type LiveSource =
  | { kind: 'pglite'; live: LiveNamespace }
  | { kind: 'electron'; bridge: ElectronLiveBridge };

/** What one subscription was opened for. The rows it delivers answer exactly this. */
interface LiveRowsIdentity {
  readonly key: string | undefined;
  readonly limit: number | undefined;
  readonly mode: 'query' | 'incremental';
  readonly offset: number | undefined;
  readonly paramsDep: string | readonly unknown[] | undefined;
  readonly query: string;
  readonly source: LiveSource | null;
}

function sameLiveRowsIdentity(a: LiveRowsIdentity | null, b: LiveRowsIdentity): boolean {
  return (
    a !== null &&
    a.source === b.source &&
    a.query === b.query &&
    a.paramsDep === b.paramsDep &&
    a.mode === b.mode &&
    a.key === b.key &&
    a.limit === b.limit &&
    a.offset === b.offset
  );
}

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
    return { bridge, kind: 'electron' };
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
      params,
      query: escapePGliteLiveQueryFormatPercents(options.query, params),
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

export async function subscribeViaElectron<T>(
  bridge: ElectronLiveBridge,
  options: InternalLiveQueryOptions,
  onUpdate: (results: LiveQueryResults<T>) => void
): Promise<LiveSubscription<T>> {
  const startPayload: ElectronLiveQueryStartOptions = {
    mode: options.mode,
    params: options.params ?? null,
    query: escapePGliteLiveQueryFormatPercents(options.query, options.params),
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

  const startResult = await measureDatabaseQuery(
    'live-query',
    async () => await bridge.start<T>(startPayload)
  );

  const unsubscribeUpdates = bridge.onUpdate((payload) => {
    if (payload.id !== startResult.id) {
      return;
    }
    recordDatabaseLiveUpdate();
    onUpdate(payload.results as LiveQueryResults<T>);
  });
  recordDatabaseLiveSubscriptionStarted();
  let localReleased = false;
  let remoteStopped = false;
  let stopPromise: Promise<void> | null = null;

  const releaseLocalOnce = (): void => {
    if (localReleased) {
      return;
    }
    localReleased = true;
    try {
      unsubscribeUpdates();
    } finally {
      recordDatabaseLiveSubscriptionEnded();
    }
  };

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
      await measureDatabaseQuery('live-query', async () => {
        await bridge.refresh(refreshPayload);
      });
    },
    unsubscribe: () => {
      if (remoteStopped) {
        return Promise.resolve();
      }
      if (stopPromise) {
        return stopPromise;
      }
      releaseLocalOnce();
      const attempt = (async () => {
        await bridge.stop(startResult.id);
        remoteStopped = true;
      })();
      let shared: Promise<void>;
      shared = attempt.finally(() => {
        if (stopPromise === shared) {
          stopPromise = null;
        }
      });
      stopPromise = shared;
      return shared;
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
  const db = usePGliteDatabase({ enabled: options.enabled !== false });
  const drainRegistry = useLiveQueryDrainRegistry();
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
  // The subscription the current rows came from; see `rowsMatchQuery`.
  const [rowsIdentity, setRowsIdentity] = useState<LiveRowsIdentity | null>(null);
  const queryIdentity = useMemo<LiveRowsIdentity>(
    () => ({
      key: options.key,
      limit: options.limit,
      mode,
      offset: options.offset,
      paramsDep,
      query: options.query,
      source,
    }),
    [mode, options.key, options.limit, options.offset, options.query, paramsDep, source]
  );

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
    // BST-1329: every unsubscribe is routed through the provider's drain
    // registry (when one exists) so factory reset / unmount can AWAIT it
    // before closing PGlite — a still-subscribed handle's internal refresh
    // statements racing close() is the BST-1320 wedge.
    let registration: LiveQueryDrainRegistration | null = null;

    if (!enabled) {
      if (options.clearOnDisable) {
        setRawRows([]);
      }
      // Nothing observes changes while disabled, so rows kept through it stop
      // answering the query until a re-enabled subscription delivers again.
      setRowsIdentity(null);
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
      setRowsIdentity(queryIdentity);
    };

    setLoading(true);
    setError(null);

    const currentParams = effectiveParamsRef.current;
    const normalizedOptions: InternalLiveQueryOptions = {
      mode,
      query: options.query,
      ...(currentParams === undefined ? {} : { params: currentParams }),
      ...(options.offset === undefined ? {} : { offset: options.offset }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.key ? { key: options.key } : {}),
    };

    void subscribeToLiveSource<T>(source as LiveSource, normalizedOptions, handleUpdate)
      .then((result) => {
        // Register before the cancelled check: even an immediately discarded
        // subscription's unsubscribe is in-flight database work a concurrent
        // reset must be able to join.
        const liveRegistration = drainRegistry
          ? drainRegistry.register(() => result.unsubscribe())
          : null;
        if (cancelled) {
          void (liveRegistration?.unsubscribe() ?? result.unsubscribe()).catch((error: unknown) => {
            logger.error('Live query unsubscribe failed after a cancelled subscription', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
          return;
        }
        subscription = result;
        registration = liveRegistration;
        refreshRef.current = async () => {
          await result.refresh();
        };
        setRawRows(result.initialResults.rows as T[]);
        setRowsIdentity(queryIdentity);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        const normalized = err instanceof Error ? err : new Error(String(err));
        setError(normalized);
        setRawRows([]);
        setRowsIdentity(null);
        setLoading(false);
        refreshRef.current = noopAsync;
      });

    return () => {
      cancelled = true;
      refreshRef.current = noopAsync;
      if (subscription) {
        // The registration dedupes with any concurrent registry drain, so the
        // underlying unsubscribe runs exactly once no matter who starts it.
        const activeSubscription = subscription;
        void (registration?.unsubscribe() ?? activeSubscription.unsubscribe()).catch(
          (error: unknown) => {
            logger.error('Live query unsubscribe failed during effect cleanup', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        );
      }
    };
  }, [
    enabled,
    mode,
    options.clearOnDisable,
    options.key,
    options.limit,
    options.offset,
    leaderRevision,
    paramsDep,
    drainRegistry,
    options.query,
    // Derived from the deps above, so it adds no re-subscription of its own.
    queryIdentity,
    // select intentionally omitted to prevent re-subscription
    source,
  ]);

  const refresh = useCallback(async () => {
    await refreshRef.current();
  }, []);

  const rows = useMemo(() => (select ? select(rawRows) : rawRows) as T[], [select, rawRows]);
  const rowsMatchQuery = enabled && sameLiveRowsIdentity(rowsIdentity, queryIdentity);

  return useMemo(
    () => ({
      error,
      loading,
      refresh,
      rows,
      rowsMatchQuery,
    }),
    [rows, loading, error, refresh, rowsMatchQuery]
  );
}
