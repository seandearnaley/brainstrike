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
  type TokenCacheEntry,
  TokenCacheStore,
  type TokenCountingMode,
  type UseTokenCacheReturn,
  useTokenCache,
} from '@brainstrike/token-cache';
import { createLogger } from '@brainstrike/utils';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';

const logger = createLogger('TokenCacheContext');

/**
 * PGlite database type (subset of @electric-sql/pglite)
 */
type PGliteDB = {
  query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; affectedRows?: number }>;
};

/**
 * Worker pool type
 */
type WorkerPool = {
  exec: (method: string, params: unknown[]) => Promise<unknown>;
  terminate: () => Promise<void>;
};

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
 * Context value type
 */
export type TokenCacheContextValue = UseTokenCacheReturn & {
  /** Whether the token cache infrastructure is ready */
  isReady: boolean;
  /** Current counting mode */
  countingMode: TokenCountingMode;
  /** Token cache store for background indexer integration */
  store: TokenCacheStoreLike;
};

const TokenCacheContext = createContext<TokenCacheContextValue | null>(null);

/**
 * Props for TokenCacheProvider
 */
type TokenCacheProviderProps = {
  /** PGlite database instance (or compatible interface) */
  db: PGliteDB | null;
  /** Worker URL for the token cache worker */
  workerUrl?: string;
  /** Callback when token count is resolved */
  onTokenResolved?: (folderId: string, filePath: string, tokenCount: number) => void;
  /** Children to render */
  children: ReactNode;
};

function createNoopWorkerPool(): WorkerPool {
  return {
    exec: async () => ({ tokenCount: 0, contentHash: '' }),
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
  // Log db prop value for debugging
  logger.info('TokenCacheProvider render', { hasDb: db !== null, dbType: db ? typeof db : 'null' });

  const fallbackStoreRef = useState(() => new InMemoryTokenCacheStore())[0];
  const [store, setStore] = useState<TokenCacheStoreLike>(fallbackStoreRef);
  const [hasPersistentStore, setHasPersistentStore] = useState(false);
  const [hasher] = useState(() => new FileHasher());
  const noopWorkerPool = useState(createNoopWorkerPool)[0];
  const [workerPool, setWorkerPool] = useState<WorkerPool>(noopWorkerPool);
  const [workerReady, setWorkerReady] = useState(false);
  const [hasherReady, setHasherReady] = useState(false);

  // Get counting mode preference
  const accuratePreference = useTokenPreferencesStore(tokenPreferencesSelectors.accurateCounting);
  const countingMode: TokenCountingMode = accuratePreference ? 'accurate' : 'heuristic';

  // Initialize store when db becomes available
  useEffect(() => {
    if (!db) {
      logger.info('TokenCacheProvider: db not available, using fallback store');
      setStore(fallbackStoreRef);
      setHasPersistentStore(false);
      return;
    }

    logger.info('TokenCacheProvider: db available, creating persistent store');
    setStore(
      new TokenCacheStore(db as unknown as ConstructorParameters<typeof TokenCacheStore>[0])
    );
    setHasPersistentStore(true);
    logger.info('TokenCacheProvider: hasPersistentStore set to true');
  }, [db, fallbackStoreRef]);

  // Initialize hasher once
  useEffect(() => {
    let cancelled = false;
    logger.info('TokenCacheProvider: initializing hasher');
    void hasher.init().then(() => {
      if (cancelled) {
        logger.warn('TokenCacheProvider: hasher init completed but effect was cancelled');
      } else {
        logger.info('TokenCacheProvider: hasher initialized, setting hasherReady=true');
        setHasherReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [hasher]);

  // Initialize worker pool
  useEffect(() => {
    const url = workerUrl ?? new URL('@brainstrike/token-cache/worker', import.meta.url).href;
    logger.info('TokenCacheProvider: creating worker pool', { url });
    const pool = createTokenCacheWorkerPool(url);
    setWorkerPool(pool as WorkerPool);
    setWorkerReady(true);
    logger.info('TokenCacheProvider: workerReady set to true');

    return () => {
      logger.info('TokenCacheProvider: cleaning up worker pool');
      setWorkerReady(false);
      void pool.terminate();
      setWorkerPool(noopWorkerPool);
    };
  }, [noopWorkerPool, workerUrl]);

  // Use the token cache hook with initialized infrastructure
  // WorkerPool interface is compatible with Pool from workerpool
  const tokenCache = useTokenCache({
    store: store as TokenCacheStore,
    hasher,
    workerPool: workerPool as unknown as ReturnType<typeof createTokenCacheWorkerPool>,
    countingMode,
    ...(onTokenResolved ? { onTokenResolved } : {}),
  });

  const isReady = Boolean(db) && workerReady && hasherReady && hasPersistentStore;

  // Log readiness state for debugging
  useEffect(() => {
    logger.info('TokenCacheProvider: readiness check', {
      hasDb: Boolean(db),
      workerReady,
      hasherReady,
      hasPersistentStore,
      isReady,
    });
  }, [db, workerReady, hasherReady, hasPersistentStore, isReady]);

  const disabledTokenCache = useMemo<UseTokenCacheReturn>(
    () => ({
      getTokenCount: () => null,
      getTotalTokens: async () => 0,
      isLoading: () => false,
      isAnyLoading: false,
      queueForCounting: () => {},
      preloadFolder: async () => {},
      clearHotCache: () => {},
      invalidate: () => {},
      updateHotCache: () => {},
      cacheVersion: 0,
    }),
    []
  );

  const contextValue = useMemo<TokenCacheContextValue>(
    () => ({
      ...(isReady ? tokenCache : disabledTokenCache),
      isReady,
      countingMode,
      store,
    }),
    [tokenCache, disabledTokenCache, isReady, countingMode, store]
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
