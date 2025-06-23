import os from 'node:os';
import path from 'node:path';
import { createLogger, isDevEnv } from '@brainstrike/utils';
import type { PGlite } from '@electric-sql/pglite';
import type React from 'react';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { migrate } from './migrations/bootstrap.js';
import { ElectronFileRecordRepository } from './repositories/electron-file-record-repository.js';
import { FileRecordRepository } from './repositories/file-record-repository.js';
import { wasmLoader } from './wasm-loader.js';

// Type augmentation for window.electronAPI
declare global {
  interface Window {
    electronAPI?: {
      db?: {
        query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
        exec: (sql: string) => Promise<void>;
        test?: () => Promise<{ success: boolean; message: string; dbLocation: string }>;
      };
    };
  }
}

const logger = createLogger('DbProvider');

interface DbContextValue {
  fileRecordRepository: FileRecordRepository | ElectronFileRecordRepository | null;
  error: Error | null;
  ready: boolean;
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
  const [contextValue, setContextValue] = useState<DbContextValue>({
    fileRecordRepository: null,
    error: null,
    ready: false,
  });

  const dbRef = useRef<PGlite | null>(null);
  const initializingRef = useRef<boolean>(false);

  useEffect(() => {
    let cancelled = false;

    const initializeDb = async () => {
      if (initializingRef.current || (dbRef.current && !useElectronIPC)) {
        return;
      }

      initializingRef.current = true;

      try {
        if (useElectronIPC && typeof window !== 'undefined' && window.electronAPI?.db) {
          logger.info('Using Electron IPC database connection');

          // Test the connection first
          if (window.electronAPI.db.test) {
            try {
              const testResult = await window.electronAPI.db.test();
              if (!testResult.success) {
                throw new Error(`Database test failed: ${testResult.message}`);
              }
              logger.info('Database test passed:', testResult.message);
            } catch (error) {
              logger.warn('Database test not available or failed:', error);
            }
          }

          // Create repository with IPC adapter
          const repository = new ElectronFileRecordRepository(window.electronAPI.db);

          if (!cancelled) {
            setContextValue({
              fileRecordRepository: repository,
              error: null,
              ready: true,
            });
          }
        } else {
          // Existing web/browser logic
          logger.info('Using direct PGlite connection');
          const db = await wasmLoader.createPGlite(resolvedPath);
          dbRef.current = db;

          await migrate(db);

          const repository = new FileRecordRepository(db);

          if (!cancelled) {
            setContextValue({ fileRecordRepository: repository, error: null, ready: true });
          }
        }
      } catch (err) {
        logger.error('Failed to initialize database:', err);
        if (!cancelled) {
          setContextValue({ fileRecordRepository: null, error: err as Error, ready: true });
        }
      } finally {
        initializingRef.current = false;
      }
    };

    initializeDb();

    return () => {
      cancelled = true;
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
  }, [resolvedPath, useElectronIPC]);

  const memoizedValue = useMemo(() => contextValue, [contextValue]);

  return <DbContext.Provider value={memoizedValue}>{children}</DbContext.Provider>;
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
