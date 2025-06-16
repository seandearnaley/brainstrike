import { isDevEnv } from '@brainstrike/utils';
import type { PGlite } from '@electric-sql/pglite';
import type React from 'react';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { migrate } from './migrations/bootstrap.js';
import { FileRecordRepository } from './repositories/file-record-repository.js';
import { wasmLoader } from './wasm-loader.js';

interface DbContextValue {
  fileRecordRepository: FileRecordRepository | null;
  error: Error | null;
  ready: boolean;
}

interface DbProviderProps {
  children: React.ReactNode;
  dbPath?: string;
}

export function getDefaultDbPath() {
  const isBrowser = typeof window !== 'undefined';
  if (isBrowser) {
    return 'idb://app';
  }

  // For Node.js/Electron environments, use a more appropriate default path
  // In Electron, this should be overridden by the main process with app.getPath('userData')
  // For now, use a safer default that's more likely to be writable
  try {
    // Use OS-specific temp/user directory as fallback
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript strict mode requires bracket notation for process.env
    return process.env['TMPDIR'] || process.env['TEMP'] || process.env['TMP'] || './app.db';
  } catch {
    return './app.db';
  }
}

const DbContext = createContext<DbContextValue | undefined>(undefined);

export function DbProvider({ children, dbPath }: DbProviderProps) {
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
      if (initializingRef.current || dbRef.current) {
        return;
      }

      initializingRef.current = true;

      try {
        const db = await wasmLoader.createPGlite(resolvedPath);
        dbRef.current = db;

        await migrate(db);

        const repository = new FileRecordRepository(db);

        if (!cancelled) {
          setContextValue({ fileRecordRepository: repository, error: null, ready: true });
        }
      } catch (err) {
        console.error('Failed to initialize and migrate database:', err);
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
          db.close().catch((err) => {
            console.error('Failed to close database:', err);
          });
          dbRef.current = null;
        }
        // In development, we keep the database open but still reset the initialization flag
        // The database will be reused if the same path is requested again
      }
      initializingRef.current = false;
    };
  }, [resolvedPath]);

  const memoizedValue = useMemo(() => contextValue, [contextValue]);

  return <DbContext.Provider value={memoizedValue}>{children}</DbContext.Provider>;
}

export function useFileRecordRepository(): FileRecordRepository | null {
  const ctx = useContext(DbContext);
  if (!ctx) {
    // This case should ideally not be hit if the hook is used correctly
    // within a component tree wrapped by DbProvider.
    console.warn('useFileRecordRepository must be used within a DbProvider');
    return null;
  }
  // Only return the repository if the DB is ready and there's no error
  return ctx.ready && !ctx.error ? ctx.fileRecordRepository : null;
}
