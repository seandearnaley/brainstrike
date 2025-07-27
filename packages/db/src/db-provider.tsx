import os from 'node:os';
import path from 'node:path';
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
import { wasmLoader } from './wasm-loader.js';

const logger = createLogger('DbProvider');

interface DbContextValue {
  fileRecordRepository: FileRecordRepository | ElectronFileRecordRepository | null;
  chunkRepository: FileChunkRepository | ElectronFileChunkRepository | null;
  error: Error | null;
  ready: boolean;
  db: PGlite | null; // Exposed for accessing PGlite features like FileChunkRepository
  clearAllData: () => Promise<{ deletedFiles: number; deletedChunks: number }>;
  initializeDatabase: () => Promise<void>; // Lazy initialization trigger
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
  return path.join(os.tmpdir(), 'app.db');
}

const DbContext = createContext<DbContextValue | undefined>(undefined);

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

  const dbRef = useRef<PGlite | null>(null);
  const initializingRef = useRef<boolean>(false);

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
      const chunkRepo = new ElectronFileChunkRepository({
        query: electronDB.query,
        exec: electronDB.exec,
      });

      if (!cancelled.value) {
        setFileRecordRepository(repository);
        setChunkRepository(chunkRepo);
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

      const repository = new FileRecordRepository(db);
      const chunkRepo = new FileChunkRepository(db);

      if (!cancelled.value) {
        setFileRecordRepository(repository);
        setChunkRepository(chunkRepo);
        setError(null);
        setReady(true);
      }
    },
    [resolvedPath]
  );

  const initializeDatabase = useCallback(async () => {
    if (lazyInitialized || initializingRef.current || (dbRef.current && !useElectronIPC)) {
      return;
    }

    initializingRef.current = true;
    logger.info('🚀 Lazy-loading database (triggered by actual usage)');

    try {
      const isElectronInitialized = await initializeElectronIPC({ value: false });

      if (!isElectronInitialized) {
        await initializeDirectPGlite({ value: false });
      }

      // Only set lazyInitialized to true after successful initialization
      setLazyInitialized(true);
    } catch (err) {
      logger.error('Failed to initialize database:', err);
      setFileRecordRepository(null);
      setChunkRepository(null);
      setError(err as Error);
      setReady(true);
      // Reset lazyInitialized to allow retry attempts
      setLazyInitialized(false);
    } finally {
      initializingRef.current = false;
    }
  }, [lazyInitialized, useElectronIPC, initializeElectronIPC, initializeDirectPGlite]);

  useEffect(() => {
    // No automatic initialization - only when explicitly requested
    setReady(true); // Provider is ready, but database is not yet loaded

    return () => {
      const db = dbRef.current;
      if (db) {
        if (!isDevEnv()) {
          setTimeout(() => {
            db.close().catch((err) => {
              const errorMessage = err?.message || '';
              if (!errorMessage.includes('closed') && !errorMessage.includes('PGlite is closed')) {
                logger.error('Failed to close database:', err);
              }
            });
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

      return { deletedFiles: Number(deletedFiles), deletedChunks: Number(deletedChunks) };
    });
  }, []);

  const clearAllData = useCallback(async () => {
    // Initialize database if not already initialized
    if (!lazyInitialized) {
      await initializeDatabase();
    }

    // Check if Electron IPC is actually available (not just configured)
    interface WindowWithElectronAPI extends Window {
      electronAPI?: {
        db?: {
          clearAll?: (confirmationToken?: string) => Promise<unknown>;
        };
      };
    }

    const isElectronIPCAvailable =
      useElectronIPC &&
      typeof window !== 'undefined' &&
      (window as WindowWithElectronAPI).electronAPI?.db?.clearAll;

    if (isElectronIPCAvailable) {
      return await clearViaElectronIPC();
    }

    // For direct PGlite, use transaction
    return await clearViaPGlite();
  }, [useElectronIPC, lazyInitialized, initializeDatabase, clearViaElectronIPC, clearViaPGlite]);

  const contextValue = useMemo(
    () => ({
      fileRecordRepository,
      chunkRepository,
      error,
      ready,
      db: dbRef.current,
      clearAllData,
      initializeDatabase,
    }),
    [fileRecordRepository, chunkRepository, error, ready, clearAllData, initializeDatabase]
  );

  return <DbContext.Provider value={contextValue}>{children}</DbContext.Provider>;
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

export function usePGliteDatabase(): PGlite | null {
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
