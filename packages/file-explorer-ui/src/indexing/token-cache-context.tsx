/**
 * TokenCacheContext
 *
 * React context provider for the persistent token cache.
 * Manages initialization of TokenCacheStore, FileHasher, and worker pool.
 *
 * Usage:
 * ```tsx
 * import { TokenCacheProvider, useTokenCacheContext } from './token-cache-context';
 *
 * // In your app root:
 * <TokenCacheProvider db={pgliteInstance}>
 *   <App />
 * </TokenCacheProvider>
 *
 * // In components:
 * const { getTokenCount, isAnyLoading } = useTokenCacheContext();
 * ```
 */

import {
  tokenPreferencesSelectors,
  useTokenPreferencesStore,
} from '@brainstrike/preferences/stores/token-preferences-store';
import type {
  TokenCacheEntry,
  TokenCacheRuntimeStore,
  TokenCountingMode,
  TokenCountRequest,
  TokenCountResult,
  UseTokenCacheReturn,
} from '@brainstrike/token-cache/cache-runtime';
import {
  createTokenCacheWorkerPool,
  FileHasher,
  TokenCacheStore,
  useTokenCache,
} from '@brainstrike/token-cache/cache-runtime';
import { createLogger } from '@brainstrike/utils/logger';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { resolveTokenCacheWorkerUrlHref } from './resolve-token-cache-worker-url';

const logger = createLogger('TokenCacheContext');

/**
 * PGlite database type (subset of @electric-sql/pglite)
 */
interface PGliteDB {
  query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; affectedRows?: number }>;
}

/**
 * Worker pool type
 */
interface WorkerPool {
  exec: (method: string, params: unknown[]) => Promise<unknown>;
  terminate: () => Promise<void>;
}

/** Warmup configuration constants - longer delays for Electron bundled environments */
const WARMUP_MAX_RETRIES = 3;
const WARMUP_BASE_DELAY_MS = 500;

/**
 * Runs a warmup handshake with the worker pool to ensure it's fully ready.
 * Retries with exponential backoff on failure.
 * Returns success status and number of attempts made.
 */
async function runWorkerWarmup(
  pool: WorkerPool,
  isCancelled: () => boolean
): Promise<{ attempts: number; lastError: Error | null; success: boolean }> {
  const warmupRequest: TokenCountRequest = {
    id: '__warmup__',
    content: '',
    mode: 'heuristic',
  };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < WARMUP_MAX_RETRIES; attempt++) {
    if (isCancelled()) {
      return { success: false, attempts: attempt, lastError };
    }
    try {
      await pool.exec('countTokens', [warmupRequest]);
      return { success: true, attempts: attempt + 1, lastError: null };
    } catch (error) {
      lastError =
        error instanceof Error ? error : new Error(`Token cache warmup failed: ${String(error)}`);
      const isLastAttempt = attempt === WARMUP_MAX_RETRIES - 1;
      logger.debug('TokenCacheProvider: warmup attempt failed', {
        attempt: attempt + 1,
        error: lastError.message,
        isLastAttempt,
      });
      if (!isLastAttempt) {
        const delayMs = WARMUP_BASE_DELAY_MS * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  return { success: false, attempts: WARMUP_MAX_RETRIES, lastError };
}

const terminalWorkerInitErrorsByUrl = new Map<string, Error>();

export function __resetTokenCacheWorkerInitErrorsForTests(): void {
  terminalWorkerInitErrorsByUrl.clear();
}

/**
 * Storage v5 re-keyed folder identity from filesystem paths to RootId UUIDs.
 * Token cache rows written before the re-key are keyed by paths and therefore
 * unreachable dead weight. This is a greenfield app (no back-compat), so we
 * wipe once per profile instead of migrating.
 */
export const TOKEN_CACHE_REKEY_V5_MARKER = 'token-cache-rekey-v5-done';

let rekeyWipePromise: Promise<void> | null = null;

export function __resetTokenCacheRekeyWipeForTests(): void {
  rekeyWipePromise = null;
}

async function performTokenCacheRekeyWipe(store: {
  clearAll: () => Promise<number>;
}): Promise<void> {
  if (typeof localStorage === 'undefined') {
    // Without storage we cannot gate the wipe; skip rather than re-wiping
    // fresh v5 data on every boot.
    logger.debug('Token cache re-key wipe skipped: localStorage unavailable');
    return;
  }

  let marker: string | null;
  try {
    marker = localStorage.getItem(TOKEN_CACHE_REKEY_V5_MARKER);
  } catch (error) {
    logger.warn('Token cache re-key wipe skipped: marker unreadable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (marker !== null) {
    return;
  }

  try {
    const removed = await store.clearAll();
    logger.info('Token cache wiped for RootId re-key (storage v5)', { removed });
  } catch (error) {
    // Do NOT set the marker — the wipe retries on the next boot.
    logger.warn('Token cache re-key wipe failed; will retry next boot', {
      error: error instanceof Error ? error.message : String(error),
    });
    rekeyWipePromise = null;
    return;
  }

  try {
    localStorage.setItem(TOKEN_CACHE_REKEY_V5_MARKER, 'true');
  } catch (error) {
    logger.warn('Token cache re-key marker write failed; wipe may repeat next boot', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * One-time (per profile) token cache wipe for the v5 RootId re-key.
 * Concurrent calls (e.g. StrictMode double-effects) coalesce onto a single
 * in-flight clear; the localStorage marker gates across boots.
 */
export function runTokenCacheRekeyWipeOnce(store: {
  clearAll: () => Promise<number>;
}): Promise<void> {
  if (!rekeyWipePromise) {
    rekeyWipePromise = performTokenCacheRekeyWipe(store);
  }
  return rekeyWipePromise;
}

function getResolvedTokenCacheWorkerUrl(workerUrl: string | undefined): string {
  return workerUrl ?? resolveTokenCacheWorkerUrlHref();
}

function buildTokenCacheWarmupError(attempts: number, lastError: Error | null): Error {
  const lastErrorMessage = lastError?.message;
  return new Error(
    lastErrorMessage
      ? `Token cache worker warmup failed after ${attempts} attempts: ${lastErrorMessage}`
      : `Token cache worker warmup failed after ${attempts} attempts`
  );
}

export interface TokenCacheProviderStore extends TokenCacheRuntimeStore {
  clearAll: () => Promise<number>;
  clearFolder: (folderId: string) => Promise<number>;
  delete: (folderId: string, filePath: string) => Promise<boolean>;
  findByCountingMode: (
    folderId: string,
    mode: TokenCountingMode,
    limit?: number
  ) => Promise<TokenCacheEntry[]>;
  getBatch: (
    folderId: string,
    filePaths: readonly string[]
  ) => Promise<Map<string, TokenCacheEntry>>;
  getStats: (folderId?: string) => Promise<{
    accurateCount: number;
    entryCount: number;
    heuristicCount: number;
    totalTokens: number;
  }>;
  setBatch: (entries: readonly TokenCacheEntry[]) => Promise<void>;
  vacuum: () => Promise<void>;
}

class InMemoryTokenCacheStore {
  private readonly entries = new Map<string, TokenCacheEntry>();

  private static createKey(folderId: string, filePath: string): string {
    return `${folderId}::${filePath}`;
  }

  async get(folderId: string, filePath: string): Promise<TokenCacheEntry | null> {
    return this.entries.get(InMemoryTokenCacheStore.createKey(folderId, filePath)) ?? null;
  }

  async getBatch(
    folderId: string,
    filePaths: readonly string[]
  ): Promise<Map<string, TokenCacheEntry>> {
    const result = new Map<string, TokenCacheEntry>();
    for (const filePath of filePaths) {
      const entry = await this.get(folderId, filePath);
      if (entry) {
        result.set(filePath, entry);
      }
    }
    return result;
  }

  async getAllForFolder(folderId: string): Promise<TokenCacheEntry[]> {
    const entries: TokenCacheEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.folderId === folderId) {
        entries.push(entry);
      }
    }
    return entries;
  }

  async set(entry: TokenCacheEntry): Promise<void> {
    this.entries.set(InMemoryTokenCacheStore.createKey(entry.folderId, entry.filePath), entry);
  }

  async setBatch(entries: readonly TokenCacheEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.set(entry);
    }
  }

  async delete(folderId: string, filePath: string): Promise<boolean> {
    return this.entries.delete(InMemoryTokenCacheStore.createKey(folderId, filePath));
  }

  async clearFolder(folderId: string): Promise<number> {
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${folderId}::`)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async clearAll(): Promise<number> {
    const removed = this.entries.size;
    this.entries.clear();
    return removed;
  }

  async getTotalTokens(folderId: string, filePaths: readonly string[]): Promise<number> {
    let total = 0;
    for (const filePath of filePaths) {
      const entry = await this.get(folderId, filePath);
      if (entry) {
        total += entry.tokenCount;
      }
    }
    return total;
  }

  async getStats(folderId?: string): Promise<{
    entryCount: number;
    totalTokens: number;
    accurateCount: number;
    heuristicCount: number;
  }> {
    let entryCount = 0;
    let totalTokens = 0;
    let accurateCount = 0;
    let heuristicCount = 0;

    for (const entry of this.entries.values()) {
      if (folderId && entry.folderId !== folderId) {
        continue;
      }
      entryCount += 1;
      totalTokens += entry.tokenCount;
      if (entry.countingMode === 'accurate') {
        accurateCount += 1;
      } else {
        heuristicCount += 1;
      }
    }

    return { entryCount, totalTokens, accurateCount, heuristicCount };
  }

  async findByCountingMode(
    folderId: string,
    mode: TokenCountingMode,
    limit = 100
  ): Promise<TokenCacheEntry[]> {
    const matches: TokenCacheEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.folderId === folderId && entry.countingMode === mode) {
        matches.push(entry);
        if (matches.length >= limit) {
          break;
        }
      }
    }
    return matches;
  }

  async vacuum(): Promise<void> {
    // No-op for in-memory store
  }
}

type TokenCacheStoreLike = TokenCacheProviderStore;

/**
 * Persistence mode for the token cache
 * - 'persistent': Full DB-backed storage available
 * - 'memory': Worker operational but no persistence (DB unavailable)
 * - 'disabled': Worker not yet ready
 */
export type TokenCachePersistenceMode = 'persistent' | 'memory' | 'disabled';

/**
 * Context value type
 */
export type TokenCacheContextValue = UseTokenCacheReturn & {
  /**
   * Whether the token cache infrastructure is fully ready (DB + worker + hasher).
   * @deprecated Use `isOperational` to check if counting works, or `isPersisted` for full persistence.
   */
  isReady: boolean;
  /**
   * Whether token counting is operational (worker + hasher ready).
   * When true, token counting works even if persistence is unavailable.
   */
  isOperational: boolean;
  /**
   * Whether persistence is available (DB-backed storage).
   * When true, counts are persisted to the database.
   */
  isPersisted: boolean;
  /**
   * Current persistence mode.
   * - 'persistent': Full DB-backed storage
   * - 'memory': Counting works but not persisted
   * - 'disabled': Worker not ready yet
   */
  persistenceMode: TokenCachePersistenceMode;
  /** Whether the token counting worker is ready */
  isWorkerReady: boolean;
  /** Current counting mode */
  countingMode: TokenCountingMode;
  /** Count tokens for arbitrary text (off-main-thread when worker is ready) */
  countTextTokens: (text: string) => Promise<number>;
  /** Token cache store for background indexer integration */
  store: TokenCacheStoreLike;
};

const TokenCacheContext = createContext<TokenCacheContextValue | null>(null);

/**
 * Props for TokenCacheProvider
 */
interface TokenCacheProviderProps {
  /** Children to render */
  children: ReactNode;
  /** PGlite database instance (or compatible interface) */
  db: PGliteDB | null;
  /** Delay worker startup until the first token-counting request */
  lazyWorkerInit?: boolean;
  /** Callback when token count is resolved */
  onTokenResolved?: (folderId: string, filePath: string, tokenCount: number) => void;
  /** Runtime-selected persistent store for non-PGlite database providers. */
  persistentStore?: TokenCacheProviderStore | null;
  /** Worker URL for the token cache worker */
  workerUrl?: string;
}

function createNoopWorkerPool(): WorkerPool {
  return {
    exec: async () => ({ id: '', tokenCount: 0, contentHash: '', mode: 'heuristic' }),
    terminate: async () => {},
  };
}

interface WorkerState {
  initError: Error | null;
  pool: WorkerPool;
  ready: boolean;
}

type WorkerAction =
  | { type: 'POOL_CREATED'; pool: WorkerPool }
  | { type: 'WARMUP_SUCCESS' }
  | { type: 'WARMUP_FAILED'; error: Error; noopPool: WorkerPool }
  | { type: 'RESET'; noopPool: WorkerPool };

function workerReducer(state: WorkerState, action: WorkerAction): WorkerState {
  switch (action.type) {
    case 'POOL_CREATED':
      return { ...state, pool: action.pool, ready: false, initError: null };
    case 'WARMUP_SUCCESS':
      return { ...state, ready: true, initError: null };
    case 'WARMUP_FAILED':
      return { pool: action.noopPool, ready: false, initError: action.error };
    case 'RESET':
      return { pool: action.noopPool, ready: false, initError: null };
    default:
      return state;
  }
}

/**
 * Provider component that initializes token cache infrastructure.
 */
export function TokenCacheProvider({
  db,
  lazyWorkerInit = false,
  workerUrl,
  onTokenResolved,
  persistentStore = null,
  children,
}: TokenCacheProviderProps) {
  const [inMemoryStore] = useState(() => new InMemoryTokenCacheStore());
  const [hasher] = useState(() => new FileHasher());
  const [noopWorkerPool] = useState(createNoopWorkerPool);
  const [hasherReady, setHasherReady] = useState(false);
  const [workerState, dispatchWorker] = useReducer(workerReducer, {
    pool: noopWorkerPool,
    ready: false,
    initError: null,
  });
  const workerReady = workerState.ready;
  const workerInitError = workerState.initError;
  const workerPoolRef = useRef<WorkerPool | null>(null);
  const workerInitPromiseRef = useRef<Promise<WorkerPool> | null>(null);
  const providerDisposedRef = useRef(false);
  const workerReadyRef = useRef(workerReady);
  const workerInitErrorRef = useRef(workerInitError);

  workerReadyRef.current = workerReady;
  workerInitErrorRef.current = workerInitError;

  // Get counting mode preference
  const accuratePreference = useTokenPreferencesStore(tokenPreferencesSelectors.accurateCounting);
  const countingMode: TokenCountingMode = accuratePreference ? 'accurate' : 'heuristic';

  const dbQuery = db?.query ?? null;
  const pglitePersistentStore = useMemo<TokenCacheStore | null>(() => {
    if (!dbQuery) {
      return null;
    }
    const queryOnlyDb: PGliteDB = { query: dbQuery };
    return new TokenCacheStore(
      queryOnlyDb as unknown as ConstructorParameters<typeof TokenCacheStore>[0]
    );
  }, [dbQuery]);

  // Derive the store without a setState-in-effect cascade or render-time ref
  // access. An explicit persistentStore covers non-PGlite runtimes; otherwise
  // the stable db.query function controls PGlite persistence.
  const storeState = useMemo<{ store: TokenCacheStoreLike; hasPersistentStore: boolean }>(() => {
    if (persistentStore) {
      return { store: persistentStore, hasPersistentStore: true };
    }

    if (pglitePersistentStore) {
      return { store: pglitePersistentStore, hasPersistentStore: true };
    }

    return { store: inMemoryStore, hasPersistentStore: false };
  }, [inMemoryStore, persistentStore, pglitePersistentStore]);
  const store = storeState.store;
  const hasPersistentStore = storeState.hasPersistentStore;

  // One-time hygiene wipe for the storage v5 RootId re-key. Only the
  // persistent store matters — in-memory stores are born empty, and wiping
  // one must not consume the once-per-profile marker.
  useEffect(() => {
    if (!hasPersistentStore) {
      return;
    }
    void runTokenCacheRekeyWipeOnce(store);
  }, [hasPersistentStore, store]);

  // Initialize hasher once
  useEffect(() => {
    let cancelled = false;
    logger.debug('TokenCacheProvider: initializing hasher');
    void hasher.init().then(() => {
      if (cancelled) {
        logger.debug('TokenCacheProvider: hasher init completed after cleanup');
      } else {
        logger.debug('TokenCacheProvider: hasher initialized, setting hasherReady=true');
        setHasherReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [hasher]);

  const initializeWorkerPool = useCallback(async (): Promise<WorkerPool> => {
    const markWorkerUnavailable = (resolvedWorkerUrl: string, error: Error): void => {
      terminalWorkerInitErrorsByUrl.set(resolvedWorkerUrl, error);
      dispatchWorker({ type: 'WARMUP_FAILED', error, noopPool: noopWorkerPool });
    };

    const throwIfWorkerUnavailable = (resolvedWorkerUrl: string): void => {
      if (providerDisposedRef.current) {
        throw new Error('Token cache worker requested after provider cleanup');
      }

      const terminalInitError = terminalWorkerInitErrorsByUrl.get(resolvedWorkerUrl);
      if (terminalInitError) {
        dispatchWorker({
          type: 'WARMUP_FAILED',
          error: terminalInitError,
          noopPool: noopWorkerPool,
        });
        throw terminalInitError;
      }

      if (workerInitErrorRef.current) {
        throw workerInitErrorRef.current;
      }
    };

    const createAndWarmWorkerPool = async (resolvedWorkerUrl: string): Promise<WorkerPool> => {
      const pool = (await createTokenCacheWorkerPool(resolvedWorkerUrl)) as WorkerPool;
      if (providerDisposedRef.current) {
        await pool.terminate();
        throw new Error('Token cache worker initialization was cancelled during cleanup');
      }

      workerPoolRef.current = pool;
      dispatchWorker({ type: 'POOL_CREATED', pool });

      const result = await runWorkerWarmup(pool, () => providerDisposedRef.current);
      if (providerDisposedRef.current) {
        await pool.terminate();
        throw new Error('Token cache worker warmup was cancelled during cleanup');
      }

      if (!result.success) {
        const warmupError = buildTokenCacheWarmupError(result.attempts, result.lastError);
        logger.error(warmupError.message, { attempts: result.attempts });
        markWorkerUnavailable(resolvedWorkerUrl, warmupError);
        workerPoolRef.current = null;
        await pool.terminate();
        throw warmupError;
      }

      terminalWorkerInitErrorsByUrl.delete(resolvedWorkerUrl);
      dispatchWorker({ type: 'WARMUP_SUCCESS' });
      logger.debug('TokenCacheProvider: worker warmup succeeded', {
        attempts: result.attempts,
        lazyWorkerInit,
      });
      return pool;
    };

    const resolvedWorkerUrl = getResolvedTokenCacheWorkerUrl(workerUrl);
    throwIfWorkerUnavailable(resolvedWorkerUrl);

    if (workerReadyRef.current && workerPoolRef.current) {
      return workerPoolRef.current;
    }

    if (workerInitPromiseRef.current) {
      return workerInitPromiseRef.current;
    }

    logger.debug('TokenCacheProvider: creating worker pool', {
      url: resolvedWorkerUrl,
      lazyWorkerInit,
    });

    const initPromise = createAndWarmWorkerPool(resolvedWorkerUrl).catch((error: unknown) => {
      const initError =
        error instanceof Error
          ? error
          : new Error(`Failed to create token cache worker pool: ${String(error)}`);
      if (!providerDisposedRef.current) {
        logger.error('TokenCacheProvider: failed to create worker pool', { error: initError });
        markWorkerUnavailable(resolvedWorkerUrl, initError);
      }
      workerPoolRef.current = null;
      throw initError;
    });

    workerInitPromiseRef.current = initPromise;
    try {
      return await initPromise;
    } finally {
      if (workerInitPromiseRef.current === initPromise) {
        workerInitPromiseRef.current = null;
      }
    }
  }, [lazyWorkerInit, noopWorkerPool, workerUrl]);

  const workerPoolProxy = useMemo<WorkerPool>(
    () => ({
      exec: async (method: string, params: unknown[]) => {
        const pool =
          workerReady && workerPoolRef.current
            ? workerPoolRef.current
            : await initializeWorkerPool();
        return pool.exec(method, params);
      },
      terminate: async () => {
        if (workerPoolRef.current) {
          await workerPoolRef.current.terminate();
          workerPoolRef.current = null;
        }
        dispatchWorker({ type: 'RESET', noopPool: noopWorkerPool });
      },
    }),
    [initializeWorkerPool, noopWorkerPool, workerReady]
  );

  useEffect(() => {
    providerDisposedRef.current = false;
    if (!lazyWorkerInit) {
      void initializeWorkerPool().catch(() => {
        // Initialization failures are surfaced through workerInitError and structured logs.
      });
    }

    return () => {
      providerDisposedRef.current = true;
      logger.debug('TokenCacheProvider: cleaning up worker pool');
      const pool = workerPoolRef.current;
      workerPoolRef.current = null;
      workerInitPromiseRef.current = null;
      if (pool) {
        void pool.terminate();
      }
      dispatchWorker({ type: 'RESET', noopPool: noopWorkerPool });
    };
  }, [initializeWorkerPool, lazyWorkerInit, noopWorkerPool]);

  // Use the token cache hook with initialized infrastructure
  // WorkerPool interface is compatible with WorkerPoolLike from useTokenCache
  const tokenCache = useTokenCache({
    store,
    hasher,
    workerPool: workerPoolProxy,
    countingMode,
    ...(onTokenResolved ? { onTokenResolved } : {}),
  });

  // Two-tier readiness semantics (BST-150):
  // - isOperational: Worker + hasher ready (can count tokens, even without DB)
  // - isPersisted: Operational + DB available (full persistence)
  // A lazily configured provider is still non-operational until the worker has actually warmed.
  const isOperational = hasherReady && workerReady;
  const isPersisted = isOperational && hasPersistentStore;

  // Backwards compatibility: isReady = isPersisted
  const isReady = isPersisted;

  // Compute persistence mode
  const persistenceMode: TokenCachePersistenceMode = isPersisted
    ? 'persistent'
    : isOperational
      ? 'memory'
      : 'disabled';

  const countTextTokens = useMemo(
    () => async (text: string) => {
      if (!text) {
        return 0;
      }

      if (workerInitError) {
        throw workerInitError;
      }

      try {
        const request: TokenCountRequest = {
          id: '__text__',
          content: text,
          mode: countingMode,
        };

        const result = (await workerPoolProxy.exec('countTokens', [request])) as TokenCountResult;
        const tokenCount = result.tokenCount;
        if (typeof tokenCount === 'number') {
          return tokenCount;
        }
        return 0;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        throw new Error(`Token cache worker countTokens failed: ${errMsg}`);
      }
    },
    [countingMode, workerInitError, workerPoolProxy]
  );

  const disabledTokenCache = useMemo<UseTokenCacheReturn>(
    () => ({
      getTokenCount: () => null,
      getFileSize: () => undefined,
      getTotalTokens: async () => 0,
      isLoading: () => false,
      isAnyLoading: false,
      queueForCounting: () => {},
      preloadFolder: async () => {},
      clearHotCache: () => {},
      invalidate: () => {},
      updateHotCache: () => {},
      updateFileSizeCache: () => {},
      cacheVersion: 0,
    }),
    []
  );

  const contextValue = useMemo<TokenCacheContextValue>(
    () => ({
      // Enable counting when operational (even without persistence)
      ...(isOperational ? tokenCache : disabledTokenCache),
      isReady, // Deprecated - use isOperational or isPersisted
      isOperational,
      isPersisted,
      persistenceMode,
      isWorkerReady: workerReady,
      countingMode,
      countTextTokens,
      store,
    }),
    [
      tokenCache,
      disabledTokenCache,
      isReady,
      isOperational,
      isPersisted,
      persistenceMode,
      workerReady,
      countingMode,
      countTextTokens,
      store,
    ]
  );

  return <TokenCacheContext.Provider value={contextValue}>{children}</TokenCacheContext.Provider>;
}

/**
 * Hook to access the token cache context.
 * Must be used within a TokenCacheProvider.
 */
export function useTokenCacheContext(): TokenCacheContextValue {
  const context = useContext(TokenCacheContext);
  if (!context) {
    throw new Error('useTokenCacheContext must be used within a TokenCacheProvider');
  }
  return context;
}

/**
 * Optional hook that returns null if not within a provider.
 * Useful for components that can work with or without token caching.
 */
export function useOptionalTokenCacheContext(): TokenCacheContextValue | null {
  return useContext(TokenCacheContext);
}
