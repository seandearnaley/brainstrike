import { createLogger, isDevEnv } from '@brainstrike/utils';
import type { PGlite } from '@electric-sql/pglite';
import type React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { migrate } from './migrations/bootstrap.js';
import { ElectronFileChunkRepository } from './repositories/electron-file-chunk-repository.js';
import { ElectronFileRecordRepository } from './repositories/electron-file-record-repository.js';
import { FileChunkRepository } from './repositories/file-chunk-repository.js';
import { FileRecordRepository } from './repositories/file-record-repository.js';
import type { IDatabase } from './repositories/interfaces.js';
import { wasmLoader } from './wasm-loader.js';

const logger = createLogger('DbProvider');

interface DbHandle extends IDatabase {
  exec?: (sql: string, params?: unknown[]) => Promise<unknown>;
  readonly raw?: unknown;
}

type QueryExecutor = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  exec?: (sql: string, params?: unknown[]) => Promise<unknown>;
  transaction?: <T>(fn: (tx: QueryExecutor) => Promise<T>) => Promise<T>;
};

interface DbContextValue {
  fileRecordRepository: FileRecordRepository | ElectronFileRecordRepository | null;
  chunkRepository: FileChunkRepository | ElectronFileChunkRepository | null;
  error: Error | null;
  ready: boolean;
  db: DbHandle | null;
  clearAllData: () => Promise<{ deletedFiles: number; deletedChunks: number }>;
  initializeDatabase: () => Promise<void>; // Lazy initialization trigger
  vectorEnabled: boolean; // Whether pgvector extension is available
  factoryReset: () => Promise<void>; // Close DB, wipe state, reinitialize
  clearQueuesAndEmbeddingSets: () => Promise<void>; // Helper to purge job_queue and embedding_sets
}

interface DbProviderProps {
  children: React.ReactNode;
  dbPath?: string;
  useElectronIPC?: boolean;
}

export function getDefaultDbPath() {
  const isBrowser = typeof window !== 'undefined';
  if (isBrowser) {
    return 'idb://app';
  }

  // For Node.js/Electron environments, default to a temp directory
  // Use dynamic imports to avoid bundling Node built-ins in browser builds
  const { tmpdir } = requireNodeOs();
  const { join } = requireNodePath();
  return join(tmpdir(), 'app.db');
}

// Lazily require Node built-ins without creating static import edges in the bundle
function requireNodeOs(): { tmpdir: () => string } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('node:os');
}

function requireNodePath(): { join: (...parts: string[]) => string } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('node:path');
}

const DbContext = createContext<DbContextValue | undefined>(undefined);

/** Clear active embedding set ID from localStorage to prevent stale collection references */
function clearActiveEmbeddingSetIdFromStorage(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem('brainstrike.activeEmbeddingSetId');
    logger.info('[DbProvider] Cleared active embedding set ID from localStorage');
  } catch (err) {
    logger.warn('[DbProvider] Failed to clear active embedding set ID:', err);
  }
}

function createDbHandle(executor: QueryExecutor): DbHandle {
  const query = executor.query.bind(executor) as DbHandle['query'];
  const handle: DbHandle = {
    query,
  };

  if (typeof executor.exec === 'function') {
    handle.exec = executor.exec.bind(executor);
  }

  if (typeof executor.transaction === 'function') {
    const tx = executor.transaction;
    const transactionWrapper: DbHandle['transaction'] = async <T,>(
      fn: (txHandle: DbHandle) => Promise<T>
    ) => {
      return tx.call(executor, async (inner) => fn(createDbHandle(inner))) as Promise<T>;
    };
    handle.transaction = transactionWrapper;
  }

  Object.defineProperty(handle, 'raw', {
    value: executor,
    enumerable: false,
    configurable: false,
  });

  return handle;
}

export function DbProvider({ children, dbPath, useElectronIPC }: DbProviderProps) {
  const resolvedPath = dbPath ?? getDefaultDbPath();
  const [fileRecordRepository, setFileRecordRepository] = useState<
    FileRecordRepository | ElectronFileRecordRepository | null
  >(null);
  const [chunkRepository, setChunkRepository] = useState<
    FileChunkRepository | ElectronFileChunkRepository | null
  >(null);
  const [error, setError] = useState<Error | null>(null);
  const [ready, setReady] = useState(false);
  const [lazyInitialized, setLazyInitialized] = useState(false);
  const [vectorEnabled, setVectorEnabled] = useState(false);
  const [exposedDb, setExposedDb] = useState<DbHandle | null>(null);

  const dbRef = useRef<PGlite | null>(null);
  const initializingRef = useRef<boolean>(false);
  const initializingPromiseRef = useRef<Promise<void> | null>(null);

  // biome-ignore lint/suspicious/noExplicitAny: Electron API type varies by environment
  const testElectronConnection = useCallback(async (electronDB: any) => {
    if (!electronDB.test) return;

    try {
      const testResult = await electronDB.test();
      if (!testResult.success) {
        throw new Error(`Database test failed: ${testResult.message}`);
      }
      logger.info('Database test passed:', testResult.message);
    } catch (error) {
      logger.warn('Database test not available or failed:', error);
    }
  }, []);

  const initializeElectronIPC = useCallback(
    async (cancelled: { value: boolean }) => {
      // biome-ignore lint/suspicious/noExplicitAny: Electron API type varies by environment
      if (!(useElectronIPC && typeof window !== 'undefined' && (window as any).electronAPI?.db)) {
        return false;
      }

      logger.info('Using Electron IPC database connection');

      // TypeScript doesn't narrow the type properly, so we assert it exists
      // biome-ignore lint/suspicious/noExplicitAny: Electron API type varies by environment
      const electronDB = (window as any).electronAPI.db;
      await testElectronConnection(electronDB);

      // The repository doesn't need the test method, so we can pass just the db interface
      const repository = new ElectronFileRecordRepository({
        query: electronDB.query,
        exec: electronDB.exec,
      });
      // Detect pgvector extension availability over IPC
      let hasVector = false;
      try {
        const res = await electronDB.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
        hasVector = Array.isArray(res.rows) && res.rows.length > 0;
      } catch (_err) {
        // If detection fails, assume not available
        hasVector = false;
      }
      if (!hasVector) {
        throw new Error(
          'pgvector extension is required for desktop. Ensure @electric-sql/pglite/vector is available.'
        );
      }
      const chunkRepo = new ElectronFileChunkRepository({
        query: electronDB.query,
        exec: electronDB.exec,
      });

      if (!cancelled.value) {
        dbRef.current = electronDB as unknown as PGlite;
        setExposedDb(createDbHandle(electronDB as unknown as QueryExecutor));
        setFileRecordRepository(repository);
        setChunkRepository(chunkRepo);
        setVectorEnabled(hasVector);
        setError(null);
        setReady(true);
      }
      return true;
    },
    [useElectronIPC, testElectronConnection]
  );

  const initializeDirectPGlite = useCallback(
    async (cancelled: { value: boolean }) => {
      logger.info('Using direct PGlite connection');

      const db = await wasmLoader.createPGlite(resolvedPath);
      dbRef.current = db;

      await migrate(db);

      // Check if pgvector extension is available
      let hasVector = false;
      try {
        const result = await db.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
        hasVector = result.rows.length > 0;
        logger.info(`pgvector extension ${hasVector ? 'available' : 'not available'}`);
      } catch (err) {
        logger.debug('Could not detect pgvector extension:', err);
      }
      if (!hasVector) {
        throw new Error(
          'pgvector extension failed to initialize. Ensure @electric-sql/pglite/vector is bundled.'
        );
      }

      const repository = new FileRecordRepository(db);
      const chunkRepo = new FileChunkRepository(db);

      if (!cancelled.value) {
        setFileRecordRepository(repository);
        setChunkRepository(chunkRepo);
        setVectorEnabled(hasVector);
        setError(null);
        setReady(true);
        setExposedDb(createDbHandle(db as unknown as QueryExecutor));
      }
    },
    [resolvedPath]
  );

  const initializeDatabase = useCallback(async () => {
    // Fast exits when already ready
    if (lazyInitialized || (dbRef.current && !useElectronIPC)) {
      return;
    }

    // If an initialization is in flight, wait for it
    if (initializingPromiseRef.current) {
      await initializingPromiseRef.current;
      return;
    }

    initializingRef.current = true;
    logger.info('🚀 Lazy-loading database (triggered by actual usage)');

    initializingPromiseRef.current = (async () => {
      try {
        const isElectronInitialized = await initializeElectronIPC({ value: false });
        if (!isElectronInitialized) {
          await initializeDirectPGlite({ value: false });
        }
        setLazyInitialized(true);
      } catch (err) {
        logger.error('Failed to initialize database:', err);
        setFileRecordRepository(null);
        setChunkRepository(null);
        setError(err as Error);
        setReady(true);
        setLazyInitialized(false);
      } finally {
        initializingRef.current = false;
        initializingPromiseRef.current = null;
      }
    })();

    await initializingPromiseRef.current;
  }, [lazyInitialized, useElectronIPC, initializeElectronIPC, initializeDirectPGlite]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount/unmount; initialization guarded internally
  useEffect(() => {
    // No automatic initialization in prod/dev - only when explicitly requested.
    // In test environments, eagerly initialize to simplify test timing and ensure
    // constructor calls (e.g., default path detection) are observable.
    setReady(true); // Provider is ready, but database is not yet loaded

    if (process.env['NODE_ENV'] === 'test') {
      // Fire and forget; internal guards prevent duplicate initialization
      initializeDatabase().catch((err) => {
        logger.error('Failed to eager-initialize database in test:', err);
      });
    }

    return () => {
      const db = dbRef.current;
      if (db) {
        if (!isDevEnv()) {
          setTimeout(() => {
            const closeResult = db.close();
            if (closeResult && typeof (closeResult as Promise<unknown>).catch === 'function') {
              (closeResult as Promise<void>).catch((err) => {
                const errorMessage = err?.message || '';
                if (
                  !errorMessage.includes('closed') &&
                  !errorMessage.includes('PGlite is closed')
                ) {
                  logger.error('Failed to close database:', err);
                }
              });
            }
          }, 0);
          dbRef.current = null;
        }
      }
      initializingRef.current = false;
    };
  }, []);

  const clearViaElectronIPC = useCallback(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: Electron API type varies by environment
    const electronDB = (window as any).electronAPI?.db;
    if (!electronDB?.clearAll) {
      throw new Error('Electron IPC clearAll method not available');
    }

    const result = await electronDB.clearAll('CONFIRM_CLEAR_DATABASE');
    if (result.success) {
      return {
        deletedFiles: result.deletedFiles || 0,
        deletedChunks: result.deletedChunks || 0,
      };
    }
    throw new Error(result.message || 'Failed to clear database via Electron IPC');
  }, []);

  const clearViaPGlite = useCallback(async () => {
    if (!dbRef.current) {
      await initializeDatabase();
    }
    if (!dbRef.current) {
      throw new Error('Database not available');
    }

    return await dbRef.current.transaction(async (tx) => {
      // Clear chunks first due to foreign key constraints
      const chunksResult = await tx.query('SELECT COUNT(*) as count FROM file_chunks');
      const chunksRow = chunksResult.rows[0] as { count: string | number } | undefined;
      const deletedChunks = chunksRow?.count || 0;
      await tx.query('DELETE FROM file_chunks');

      // Then clear files
      const filesResult = await tx.query('SELECT COUNT(*) as count FROM file_records');
      const filesRow = filesResult.rows[0] as { count: string | number } | undefined;
      const deletedFiles = filesRow?.count || 0;
      await tx.query('DELETE FROM file_records');

      // Also clear embedding sets and queue to avoid stale state
      try {
        await tx.query('DELETE FROM embedding_sets');
      } catch {}
      try {
        await tx.query('DELETE FROM job_queue');
      } catch {}

      return { deletedFiles: Number(deletedFiles), deletedChunks: Number(deletedChunks) };
    });
  }, [initializeDatabase]);

  const clearAllData = useCallback(async () => {
    // Initialize database if not already initialized
    if (!lazyInitialized) {
      await initializeDatabase();
    }

    // Check if Electron IPC is actually available (not just configured)
    const electronAPI =
      typeof window !== 'undefined'
        ? ((
            window as Window & {
              electronAPI?: {
                db?: { clearAll?: (confirmationToken?: string) => Promise<unknown> };
              };
            }
          ).electronAPI ?? null)
        : null;

    const isElectronIPCAvailable = useElectronIPC && electronAPI?.db?.clearAll;

    if (isElectronIPCAvailable) {
      return await clearViaElectronIPC();
    }

    // For direct PGlite, use transaction
    return await clearViaPGlite();
  }, [useElectronIPC, lazyInitialized, initializeDatabase, clearViaElectronIPC, clearViaPGlite]);

  // Helpers to reduce complexity within contextValue actions
  const purgeTablesTx = useCallback(async (tx: { query: (sql: string) => Promise<unknown> }) => {
    try {
      await tx.query('DELETE FROM job_queue');
    } catch (err) {
      logger.warn('Failed to clear job_queue during reset:', err);
    }
    try {
      await tx.query('DELETE FROM embedding_sets');
    } catch (err) {
      logger.warn('Failed to clear embedding_sets during reset:', err);
    }
    try {
      await tx.query('DELETE FROM file_chunks');
    } catch (err) {
      logger.warn('Failed to clear file_chunks during reset:', err);
    }
    try {
      await tx.query('DELETE FROM file_records');
    } catch (err) {
      logger.warn('Failed to clear file_records during reset:', err);
    }
  }, []);

  const tryElectronHardReset = useCallback(async (): Promise<boolean> => {
    // biome-ignore lint/suspicious/noExplicitAny: Electron API type varies by environment
    const w = (typeof window !== 'undefined' ? (window as any) : null) as any;
    if (!(useElectronIPC && w?.electronAPI?.db)) return false;
    try {
      await w.electronAPI.db.clearAll?.('CONFIRM_CLEAR_DATABASE');
    } catch (err) {
      logger.warn('Electron clearAll during reset failed:', err);
    }
    try {
      const res = await w.electronAPI.db.resetLocal?.();
      if (res?.success) {
        // Don't reload here - let the caller handle clearing UI state and reloading
        // This ensures clearPersistentUiState() runs before the page reloads
        return true;
      }
    } catch (err) {
      logger.warn('Electron resetLocal during reset failed:', err);
    }
    return false;
  }, [useElectronIPC]);

  const purgeAndClosePGlite = useCallback(async () => {
    if (!dbRef.current) return;
    try {
      await dbRef.current.transaction(async (tx) => {
        await purgeTablesTx(tx);
      });
    } catch {}
    try {
      await dbRef.current.exec('VACUUM');
    } catch (err) {
      logger.warn('VACUUM after purge failed:', err);
    }
    const usesIndexedDb = resolvedPath.startsWith('idb://');
    if (usesIndexedDb) {
      try {
        await wasmLoader.closeCached(resolvedPath);
        logger.info('[DbProvider] Closed cached IndexedDB instance during factory reset');
      } catch (err) {
        logger.warn('Failed to close cached IndexedDB instance during reset:', err);
      }
    } else {
      try {
        await dbRef.current.close();
      } catch (err) {
        logger.warn('Closing database after purge failed:', err);
      }
    }
    dbRef.current = null;
    setExposedDb(null);
  }, [purgeTablesTx, resolvedPath]);

  const cleanupAndWaitForReset = useCallback(async () => {
    // Delete the IndexedDB database to fully wipe corrupted TOAST chunks
    if (resolvedPath.startsWith('idb://')) {
      try {
        await wasmLoader.deleteIndexedDB(resolvedPath);
        logger.info('[DbProvider] IndexedDB deleted successfully');
        // Wait for IndexedDB deletion to fully complete
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
      } catch (err) {
        logger.warn('[DbProvider] Failed to delete IndexedDB, reinitializing anyway:', err);
      }
    } else {
      // Even for non-IDB paths, wait a bit to ensure cleanup completes
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  }, [resolvedPath]);

  const retryInitialization = useCallback(async () => {
    const maxRetries = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`[DbProvider] Reinitializing database (attempt ${attempt}/${maxRetries})`);
        await initializeDirectPGlite({ value: false });
        logger.info('[DbProvider] Database reinitialized successfully after factory reset');
        return;
      } catch (err) {
        lastError = err;
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.warn(`[DbProvider] Reinitialization attempt ${attempt} failed:`, errorMsg);

        if (attempt === maxRetries) {
          break;
        }

        const delay = attempt * 200;
        logger.info(`[DbProvider] Waiting ${delay}ms before retry...`);
        await new Promise((resolve) => {
          setTimeout(resolve, delay);
        });
      }
    }

    logger.error('[DbProvider] All reinitialization attempts failed after factory reset');
    throw lastError;
  }, [initializeDirectPGlite]);

  const resetPGliteState = useCallback(async () => {
    // Purge and close if database exists
    if (!dbRef.current) {
      logger.warn('[DbProvider] No active database to purge during factory reset');
    } else {
      await purgeAndClosePGlite();
    }

    // Reset all state
    dbRef.current = null;
    setExposedDb(null);
    setFileRecordRepository(null);
    setChunkRepository(null);
    setVectorEnabled(false);
    setReady(false);
    setLazyInitialized(false);

    // Clear active embedding set ID from localStorage to prevent stale collections
    clearActiveEmbeddingSetIdFromStorage();

    await cleanupAndWaitForReset();
    await retryInitialization();
  }, [purgeAndClosePGlite, cleanupAndWaitForReset, retryInitialization]);

  const purgeQueuesAndSetsElectron = useCallback(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: Electron API type varies by environment
    const w = (typeof window !== 'undefined' ? (window as any) : null) as any;
    if (w?.electronAPI?.db?.query) {
      try {
        await w.electronAPI.db.query('DELETE FROM job_queue');
      } catch (err) {
        logger.warn('Electron query to clear job_queue failed:', err);
      }
      try {
        await w.electronAPI.db.query('DELETE FROM embedding_sets');
      } catch (err) {
        logger.warn('Electron query to clear embedding_sets failed:', err);
      }
    }
  }, []);

  const purgeQueuesAndSetsTx = useCallback(
    async (tx: { query: (sql: string) => Promise<unknown> }) => {
      try {
        await tx.query('DELETE FROM job_queue');
      } catch (err) {
        logger.warn('Failed to clear job_queue (transaction):', err);
      }
      try {
        await tx.query('DELETE FROM embedding_sets');
      } catch (err) {
        logger.warn('Failed to clear embedding_sets (transaction):', err);
      }
    },
    []
  );

  const contextValue = useMemo(
    () => ({
      fileRecordRepository,
      chunkRepository,
      error,
      ready,
      db: exposedDb,
      clearAllData,
      initializeDatabase,
      vectorEnabled,
      factoryReset: async () => {
        // Try Electron hard reset and return if successful
        // Caller (factory-reset-panel) will handle clearing UI state and reloading
        try {
          const handled = await tryElectronHardReset();
          if (handled) {
            logger.info('[DbProvider] Electron hard reset completed');
            return;
          }
        } catch (err) {
          logger.warn(
            '[DbProvider] Electron hard reset failed, falling back to PGlite reset:',
            err
          );
        }

        // Fallback: direct PGlite purge and recreate
        await resetPGliteState();
      },
      clearQueuesAndEmbeddingSets: async () => {
        // Prefer Electron IPC when truly available; otherwise use local DB
        if (useElectronIPC) {
          // biome-ignore lint/suspicious/noExplicitAny: Electron API type varies by environment
          const w = (typeof window !== 'undefined' ? (window as any) : null) as any;
          if (w?.electronAPI?.db?.query) {
            await purgeQueuesAndSetsElectron();
            return; // IPC path executed
          }
          // If IPC not available despite flag, fall through to local path
        }
        if (!dbRef.current) return;
        await dbRef.current.transaction(async (tx) => {
          await purgeQueuesAndSetsTx(tx);
        });
      },
    }),
    [
      fileRecordRepository,
      chunkRepository,
      error,
      ready,
      clearAllData,
      initializeDatabase,
      vectorEnabled,
      useElectronIPC,
      tryElectronHardReset,
      resetPGliteState,
      purgeQueuesAndSetsElectron,
      purgeQueuesAndSetsTx,
      exposedDb,
    ]
  );

  return <DbContext.Provider value={contextValue}>{children}</DbContext.Provider>;
}

export function useVectorEnabled(): boolean {
  const context = useContext(DbContext);
  if (context === undefined) {
    throw new Error('useVectorEnabled must be used within a DbProvider');
  }
  return context.vectorEnabled;
}

export function useFileRecordRepository():
  | FileRecordRepository
  | ElectronFileRecordRepository
  | null {
  const ctx = useContext(DbContext);

  // Trigger lazy initialization when first accessed
  useEffect(() => {
    if (ctx && !ctx.fileRecordRepository && !ctx.error) {
      ctx.initializeDatabase().catch((err) => {
        logger.error('Failed to lazy-initialize database:', err);
      });
    }
  }, [ctx]);

  if (!ctx) {
    logger.warn('useFileRecordRepository must be used within a DbProvider');
    return null;
  }

  return ctx.ready && !ctx.error ? ctx.fileRecordRepository : null;
}

export function usePGliteDatabase(): DbHandle | null {
  const ctx = useContext(DbContext);

  // Trigger lazy initialization when first accessed
  useEffect(() => {
    if (ctx && !ctx.db && !ctx.error) {
      ctx.initializeDatabase().catch((err) => {
        logger.error('Failed to lazy-initialize database:', err);
      });
    }
  }, [ctx]);

  if (!ctx) {
    logger.warn('usePGliteDatabase must be used within a DbProvider');
    return null;
  }

  return ctx.ready && !ctx.error ? ctx.db : null;
}

export function useDbProviderError(): Error | null {
  const ctx = useContext(DbContext);
  if (!ctx) {
    throw new Error('useDbProviderError must be used within a DbProvider');
  }
  return ctx.error;
}

export function useFileChunkRepository(): FileChunkRepository | ElectronFileChunkRepository | null {
  const ctx = useContext(DbContext);

  // Trigger lazy initialization when first accessed
  useEffect(() => {
    if (ctx && !ctx.chunkRepository && !ctx.error) {
      ctx.initializeDatabase().catch((err) => {
        logger.error('Failed to lazy-initialize database:', err);
      });
    }
  }, [ctx]);

  if (!ctx) {
    logger.warn('useFileChunkRepository must be used within a DbProvider');
    return null;
  }

  return ctx.ready && !ctx.error ? ctx.chunkRepository : null;
}

export function useClearAllData():
  | (() => Promise<{ deletedFiles: number; deletedChunks: number }>)
  | null {
  const ctx = useContext(DbContext);

  // Trigger lazy initialization when first accessed
  useEffect(() => {
    if (ctx && !ctx.fileRecordRepository && !ctx.error) {
      ctx.initializeDatabase().catch((err) => {
        logger.error('Failed to lazy-initialize database:', err);
      });
    }
  }, [ctx]);

  if (!ctx) {
    logger.warn('useClearAllData must be used within a DbProvider');
    return null;
  }

  return ctx.ready && !ctx.error ? ctx.clearAllData : null;
}

export function useFactoryReset(): (() => Promise<void>) | null {
  const ctx = useContext(DbContext);
  useEffect(() => {
    if (ctx && !ctx.db && !ctx.error) {
      ctx.initializeDatabase().catch((err) => {
        logger.error('Failed to lazy-initialize database:', err);
      });
    }
  }, [ctx]);
  if (!ctx) return null;
  return ctx.ready && !ctx.error ? ctx.factoryReset : null;
}

export function useClearQueuesAndEmbeddingSets(): (() => Promise<void>) | null {
  const ctx = useContext(DbContext);
  useEffect(() => {
    if (ctx && !ctx.db && !ctx.error) {
      ctx.initializeDatabase().catch((err) => {
        logger.error('Failed to lazy-initialize database:', err);
      });
    }
  }, [ctx]);
  if (!ctx) return null;
  return ctx.ready && !ctx.error ? ctx.clearQueuesAndEmbeddingSets : null;
}
