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
  TokenCacheStore,
  type TokenCountingMode,
  type UseTokenCacheReturn,
  useTokenCache,
} from '@brainstrike/token-cache';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';

/**
 * PGlite database type (subset of @electric-sql/pglite)
 */
type PGliteDB = {
  query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

/**
 * Worker pool type
 */
type WorkerPool = {
  exec: (method: string, params: unknown[]) => Promise<unknown>;
  terminate: () => Promise<void>;
};

/**
 * Context value type
 */
type TokenCacheContextValue = UseTokenCacheReturn & {
  /** Whether the token cache infrastructure is ready */
  isReady: boolean;
  /** Current counting mode */
  countingMode: TokenCountingMode;
};

const TokenCacheContext = createContext<TokenCacheContextValue | null>(null);

/**
 * Props for TokenCacheProvider
 */
type TokenCacheProviderProps = {
  /** PGlite database instance (or compatible interface) */
  db: PGliteDB;
  /** Worker URL for the token cache worker */
  workerUrl?: string;
  /** Callback when token count is resolved */
  onTokenResolved?: (folderId: string, filePath: string, tokenCount: number) => void;
  /** Children to render */
  children: ReactNode;
};

/**
 * Provider component that initializes token cache infrastructure.
 */
export function TokenCacheProvider({
  db,
  workerUrl,
  onTokenResolved,
  children,
}: TokenCacheProviderProps) {
  // Cast to satisfy TokenCacheStore which expects PGlite (PGliteDB is compatible)
  const [store] = useState(
    () => new TokenCacheStore(db as unknown as ConstructorParameters<typeof TokenCacheStore>[0])
  );
  const [hasher] = useState(() => new FileHasher());
  const [workerPool, setWorkerPool] = useState<WorkerPool | null>(null);
  const [isReady, setIsReady] = useState(false);

  // Get counting mode preference
  const accuratePreference = useTokenPreferencesStore(tokenPreferencesSelectors.accurateCounting);
  const countingMode: TokenCountingMode = accuratePreference ? 'accurate' : 'heuristic';

  // Initialize worker pool
  useEffect(() => {
    // Dynamic worker URL - defaults to the token-cache worker
    const url = workerUrl ?? new URL('@brainstrike/token-cache/worker', import.meta.url).href;

    const pool = createTokenCacheWorkerPool(url);
    setWorkerPool(pool as WorkerPool);

    // Initialize hasher
    void hasher.init().then(() => {
      setIsReady(true);
    });

    return () => {
      void pool.terminate();
    };
  }, [hasher, workerUrl]);

  // Use the token cache hook with initialized infrastructure
  // WorkerPool interface is compatible with Pool from workerpool
  const tokenCache = useTokenCache({
    store,
    hasher,
    workerPool: workerPool as unknown as ReturnType<typeof createTokenCacheWorkerPool>,
    countingMode,
    ...(onTokenResolved ? { onTokenResolved } : {}),
  });

  const contextValue = useMemo<TokenCacheContextValue>(
    () => ({
      ...tokenCache,
      isReady: isReady && workerPool !== null,
      countingMode,
    }),
    [tokenCache, isReady, workerPool, countingMode]
  );

  // Don't render children until worker pool is ready
  if (!workerPool) {
    return null;
  }

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
