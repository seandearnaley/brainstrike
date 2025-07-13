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
      console.log('[DB PROVIDER DEBUG] Starting direct PGlite initialization');
      logger.info('Using direct PGlite connection');

      console.log('[DB PROVIDER DEBUG] Creating PGlite instance with path:', resolvedPath);
      const db = await wasmLoader.createPGlite(resolvedPath);
      dbRef.current = db;
      console.log('[DB PROVIDER DEBUG] PGlite instance created successfully');

      console.log('[DB PROVIDER DEBUG] Starting database migrations');
      await migrate(db);
      console.log('[DB PROVIDER DEBUG] Database migrations completed');

      const repository = new FileRecordRepository(db);
      console.log('[DB PROVIDER DEBUG] FileRecordRepository created');

      const chunkRepo = new FileChunkRepository(db);
      console.log('[DB PROVIDER DEBUG] FileChunkRepository created');

      if (!cancelled.value) {
        setFileRecordRepository(repository);
        setChunkRepository(chunkRepo);
        setError(null);
        setReady(true);
        console.log('[DB PROVIDER DEBUG] Database initialization completed successfully');
      } else {
        console.log('[DB PROVIDER DEBUG] Initialization was cancelled');
      }
    },
    [resolvedPath]
  );

  useEffect(() => {
    const cancelled = { value: false };

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This function needs to handle both Electron and web initialization paths
    const initializeDb = async () => {
      console.log('[DB PROVIDER DEBUG] initializeDb called');
      console.log('[DB PROVIDER DEBUG] Current state:', {
        initializing: initializingRef.current,
        hasDb: !!dbRef.current,
        useElectronIPC,
        cancelled: cancelled.value,
      });

      if (initializingRef.current || (dbRef.current && !useElectronIPC)) {
        console.log(
          '[DB PROVIDER DEBUG] Skipping initialization - already initializing or DB exists'
        );
        return;
      }

      initializingRef.current = true;
      console.log('[DB PROVIDER DEBUG] Starting database initialization');

      try {
        console.log('[DB PROVIDER DEBUG] Checking Electron IPC initialization');
        const isElectronInitialized = await initializeElectronIPC(cancelled);
        console.log('[DB PROVIDER DEBUG] Electron IPC initialized:', isElectronInitialized);

        if (!isElectronInitialized) {
          console.log('[DB PROVIDER DEBUG] Electron IPC not available, using direct PGlite');
          await initializeDirectPGlite(cancelled);
        }
      } catch (err) {
        console.error('[DB PROVIDER DEBUG] Database initialization failed:', err);
        logger.error('Failed to initialize database:', err);
        if (!cancelled.value) {
          setFileRecordRepository(null);
          setChunkRepository(null);
          setError(err as Error);
          setReady(true);
        }
      } finally {
        initializingRef.current = false;
        console.log('[DB PROVIDER DEBUG] Database initialization finished');
      }
    };

    void initializeDb();

    return () => {
      cancelled.value = true;
      const db = dbRef.current;
      if (db) {
        // In development, avoid closing the database during Fast Refresh
        // This prevents expensive re-initialization during HMR cycles
        if (!isDevEnv()) {
          // Use a timeout to avoid blocking the cleanup and handle potential race conditions
          setTimeout(() => {
            db.close().catch((err) => {
              // Only log the error if it's not a "database already closed" type error
              const errorMessage = err?.message || '';
              if (!errorMessage.includes('closed') && !errorMessage.includes('PGlite is closed')) {
                logger.error('Failed to close database:', err);
              }
            });
          }, 0);
          dbRef.current = null;
        }
        // In development, we keep the database open but still reset the initialization flag
        // The database will be reused if the same path is requested again
      }
      initializingRef.current = false;
    };
  }, [initializeElectronIPC, initializeDirectPGlite, useElectronIPC]);

  const contextValue = useMemo(
    () => ({ fileRecordRepository, chunkRepository, error, ready, db: dbRef.current }),
    [fileRecordRepository, chunkRepository, error, ready]
  );

  return <DbContext.Provider value={contextValue}>{children}</DbContext.Provider>;
}

export function useFileRecordRepository():
  | FileRecordRepository
  | ElectronFileRecordRepository
  | null {
  const ctx = useContext(DbContext);
  if (!ctx) {
    // This case should ideally not be hit if the hook is used correctly
    // within a component tree wrapped by DbProvider.
    logger.warn('useFileRecordRepository must be used within a DbProvider');
    return null;
  }
  // Only return the repository if the DB is ready and there's no error
  return ctx.ready && !ctx.error ? ctx.fileRecordRepository : null;
}

export function usePGliteDatabase(): PGlite | null {
  const ctx = useContext(DbContext);
  if (!ctx) {
    logger.warn('usePGliteDatabase must be used within a DbProvider');
    return null;
  }
  // Only return the database if it's ready, no error, and it's actually a PGlite instance
  return ctx.ready && !ctx.error ? ctx.db : null;
}

export function useFileChunkRepository(): FileChunkRepository | ElectronFileChunkRepository | null {
  const ctx = useContext(DbContext);
  if (!ctx) {
    logger.warn('useFileChunkRepository must be used within a DbProvider');
    return null;
  }
  // Only return the repository if the DB is ready and there's no error
  return ctx.ready && !ctx.error ? ctx.chunkRepository : null;
}
