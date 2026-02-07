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

import { tokenPreferencesSelectors, useTokenPreferencesStore } from '@brainstrike/preferences';
import {
  createTokenCacheWorkerPool,
  FileHasher,
  resolveTokenCacheWorkerUrl,
  type TokenCacheEntry,
  TokenCacheStore,
  type TokenCountingMode,
  type TokenCountRequest,
  type TokenCountResult,
  type UseTokenCacheReturn,
  useTokenCache,
} from '@brainstrike/token-cache';
import { createLogger } from '@brainstrike/utils';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';

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
): Promise<{ success: boolean; attempts: number }> {
  const warmupRequest: TokenCountRequest = {
    id: '__warmup__',
    content: '',
    mode: 'heuristic',
  };

  for (let attempt = 0; attempt < WARMUP_MAX_RETRIES; attempt++) {
    if (isCancelled()) {
      return { success: false, attempts: attempt };
    }
    try {
      await pool.exec('countTokens', [warmupRequest]);
      return { success: true, attempts: attempt + 1 };
    } catch (error) {
      const isLastAttempt = attempt === WARMUP_MAX_RETRIES - 1;
      logger.debug('TokenCacheProvider: warmup attempt failed', {
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
        isLastAttempt,
      });
      if (!isLastAttempt) {
        const delayMs = WARMUP_BASE_DELAY_MS * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  return { success: false, attempts: WARMUP_MAX_RETRIES };
}

class InMemoryTokenCacheStore {
  private readonly entries = new Map<string, TokenCacheEntry>();

  private static createKey(folderId: string, filePath: string): string {
    return `${folderId}::${filePath}`;
  }

  async get(folderId: string, filePath: string): Promise<TokenCacheEntry | null> {
    return this.entries.get(InMemoryTokenCacheStore.createKey(folderId, filePath)) ?? null;
  }

  async getBatch(folderId: string, filePaths: string[]): Promise<Map<string, TokenCacheEntry>> {
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

  async setBatch(entries: TokenCacheEntry[]): Promise<void> {
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

  async getTotalTokens(folderId: string, filePaths: string[]): Promise<number> {
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

type TokenCacheStoreLike = TokenCacheStore | InMemoryTokenCacheStore;

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
  /** PGlite database instance (or compatible interface) */
  db: PGliteDB | null;
  /** Worker URL for the token cache worker */
  workerUrl?: string;
  /** Callback when token count is resolved */
  onTokenResolved?: (folderId: string, filePath: string, tokenCount: number) => void;
  /** Children to render */
  children: ReactNode;
}

function createNoopWorkerPool(): WorkerPool {
  return {
    exec: async () => ({ id: '', tokenCount: 0, contentHash: '', mode: 'heuristic' }),
    terminate: async () => {},
  };
}

/**
 * Provider component that initializes token cache infrastructure.
 */
export function TokenCacheProvider({
  db,
  workerUrl,
  onTokenResolved,
  children,
}: TokenCacheProviderProps) {
  logger.debug('TokenCacheProvider render', {
    hasDb: db !== null,
    dbType: db ? typeof db : 'null',
  });

  const inMemoryStoreRef = useState(() => new InMemoryTokenCacheStore())[0];
  const [store, setStore] = useState<TokenCacheStoreLike>(inMemoryStoreRef);
  const [hasPersistentStore, setHasPersistentStore] = useState(false);
  const [hasher] = useState(() => new FileHasher());
  const noopWorkerPool = useState(createNoopWorkerPool)[0];
  const [workerPool, setWorkerPool] = useState<WorkerPool>(noopWorkerPool);
  const [workerReady, setWorkerReady] = useState(false);
  const [hasherReady, setHasherReady] = useState(false);
  const [workerInitError, setWorkerInitError] = useState<Error | null>(null);

  // Get counting mode preference
  const accuratePreference = useTokenPreferencesStore(tokenPreferencesSelectors.accurateCounting);
  const countingMode: TokenCountingMode = accuratePreference ? 'accurate' : 'heuristic';

  // Initialize store when db becomes available
  useEffect(() => {
    if (!db) {
      // Startup/teardown state only: DB is not ready yet, so keep writes in-memory.
      // This is not a worker-failure fallback path.
      logger.debug('TokenCacheProvider: db not available yet, using in-memory store');
      setStore(inMemoryStoreRef);
      setHasPersistentStore(false);
      return;
    }

    logger.debug('TokenCacheProvider: db available, creating persistent store');
    setStore(
      new TokenCacheStore(db as unknown as ConstructorParameters<typeof TokenCacheStore>[0])
    );
    setHasPersistentStore(true);
    logger.debug('TokenCacheProvider: hasPersistentStore set to true');
  }, [db, inMemoryStoreRef]);

  // Initialize hasher once
  useEffect(() => {
    let cancelled = false;
    logger.debug('TokenCacheProvider: initializing hasher');
    void hasher.init().then(() => {
      if (cancelled) {
        logger.warn('TokenCacheProvider: hasher init completed but effect was cancelled');
      } else {
        logger.debug('TokenCacheProvider: hasher initialized, setting hasherReady=true');
        setHasherReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [hasher]);

  // Initialize worker pool with warmup handshake
  useEffect(() => {
    const url = workerUrl ?? resolveTokenCacheWorkerUrl().href;
    logger.debug('TokenCacheProvider: creating worker pool', { url });

    let cancelled = false;
    const isCancelled = () => cancelled;
    let poolRef: WorkerPool | null = null;

    const markWorkerUnavailable = (error: Error): void => {
      setWorkerReady(false);
      setWorkerInitError(error);
      setWorkerPool(noopWorkerPool);
    };

    const initializeWorkerPool = async (): Promise<void> => {
      const pool = await createTokenCacheWorkerPool(url);
      if (cancelled) {
        void pool.terminate();
        return;
      }

      poolRef = pool as WorkerPool;
      setWorkerPool(pool as WorkerPool);

      const result = await runWorkerWarmup(pool as WorkerPool, isCancelled);
      if (cancelled) {
        return;
      }

      if (result.success) {
        setWorkerReady(true);
        setWorkerInitError(null);
        logger.debug('TokenCacheProvider: worker warmup succeeded', {
          attempts: result.attempts,
        });
        return;
      }

      // CRITICAL: No fallback mode for worker init failures.
      // A broken worker must surface as an explicit error.
      const warmupError = new Error(
        `Token cache worker warmup failed after ${result.attempts} attempts`
      );
      logger.error(warmupError.message, { attempts: result.attempts });
      markWorkerUnavailable(warmupError);
      if (poolRef) {
        void poolRef.terminate();
        poolRef = null;
      }
    };

    void initializeWorkerPool().catch((error: unknown) => {
      if (cancelled) {
        return;
      }
      const initError =
        error instanceof Error
          ? error
          : new Error(`Failed to create token cache worker pool: ${String(error)}`);
      logger.error('TokenCacheProvider: failed to create worker pool', { error: initError });
      markWorkerUnavailable(initError);
    });

    return () => {
      cancelled = true;
      logger.debug('TokenCacheProvider: cleaning up worker pool');
      setWorkerReady(false);
      setWorkerInitError(null);
      if (poolRef) {
        void poolRef.terminate();
      }
      setWorkerPool(noopWorkerPool);
    };
  }, [noopWorkerPool, workerUrl]);

  // Use the token cache hook with initialized infrastructure
  // WorkerPool interface is compatible with WorkerPoolLike from useTokenCache
  const tokenCache = useTokenCache({
    store: store as TokenCacheStore,
    hasher,
    workerPool,
    countingMode,
    ...(onTokenResolved ? { onTokenResolved } : {}),
  });

  // Two-tier readiness semantics (BST-150):
  // - isOperational: Worker + hasher ready (can count tokens, even without DB)
  // - isPersisted: Operational + DB available (full persistence)
  const isOperational = workerReady && hasherReady;
  const isPersisted = isOperational && Boolean(db) && hasPersistentStore;

  // Backwards compatibility: isReady = isPersisted
  const isReady = isPersisted;

  // Compute persistence mode
  const persistenceMode: TokenCachePersistenceMode = isPersisted
    ? 'persistent'
    : isOperational
      ? 'memory'
      : 'disabled';

  const countTextTokens = useMemo(() => {
    return async (text: string) => {
      if (!text) {
        return 0;
      }

      if (!workerReady) {
        // CRITICAL: Never fall back to heuristic/main-thread counting here.
        // If worker init failed, surface the root error directly.
        if (workerInitError) {
          throw workerInitError;
        }
        throw new Error('Token cache worker is not ready');
      }

      try {
        const request: TokenCountRequest = {
          id: '__text__',
          content: text,
          mode: countingMode,
        };

        const result = (await workerPool.exec('countTokens', [request])) as TokenCountResult;
        return typeof result.tokenCount === 'number' ? result.tokenCount : 0;
      } catch (error) {
        throw new Error(
          `Token cache worker countTokens failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    };
  }, [countingMode, workerInitError, workerPool, workerReady]);

  // Log readiness state for debugging
  useEffect(() => {
    logger.debug('TokenCacheProvider: readiness check', {
      hasDb: Boolean(db),
      workerReady,
      hasherReady,
      hasPersistentStore,
      workerInitError: workerInitError?.message ?? null,
      isOperational,
      isPersisted,
      persistenceMode,
      isReady, // deprecated alias
    });
  }, [
    db,
    workerReady,
    hasherReady,
    hasPersistentStore,
    workerInitError,
    isOperational,
    isPersisted,
    persistenceMode,
    isReady,
  ]);

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
