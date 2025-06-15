import { PGlite } from '@electric-sql/pglite';
import type React from 'react';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { migrate } from './migrations/bootstrap.js';
import { FileRecordRepository } from './repositories/file-record-repository.js';

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
  return isBrowser ? 'idb://app' : 'app.db';
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

  useEffect(() => {
    let cancelled = false;

    const initializeDb = async () => {
      try {
        const db = new PGlite(resolvedPath);
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
      }
    };

    initializeDb();

    return () => {
      cancelled = true;
      const db = dbRef.current;
      if (db) {
        db.close().catch((err) => {
          console.error('Failed to close database:', err);
        });
        dbRef.current = null;
      }
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
