import { PGlite } from '@electric-sql/pglite';
import type React from 'react';
import { createContext, useContext, useEffect, useMemo } from 'react';
import { migrate } from './migrations/bootstrap.js';
import { FileRecordRepository } from './repositories/file-record-repository.js';

interface DbContextValue {
  fileRecordRepository: FileRecordRepository;
}

interface DbProviderProps {
  children: React.ReactNode;
  dbPath?: string;
}

const DbContext = createContext<DbContextValue | undefined>(undefined);

export function DbProvider({ children, dbPath = 'app.db' }: DbProviderProps) {
  const { db, repository } = useMemo(() => {
    const db = new PGlite(dbPath);
    const repository = new FileRecordRepository(db);
    return { db, repository };
  }, [dbPath]);

  useEffect(() => {
    void migrate(db);
    return () => {
      void db.close();
    };
  }, [db]);

  const value = useMemo(() => ({ fileRecordRepository: repository }), [repository]);

  return <DbContext.Provider value={value}>{children}</DbContext.Provider>;
}

export function useFileRecordRepository(): FileRecordRepository {
  const ctx = useContext(DbContext);
  if (!ctx) {
    throw new Error('useFileRecordRepository must be used within a DbProvider');
  }
  return ctx.fileRecordRepository;
}
