import { PGlite } from '@electric-sql/pglite';
import type React from 'react';
import { createContext, useContext, useMemo } from 'react';
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
  const repository = useMemo(() => {
    const db = new PGlite(dbPath);
    return new FileRecordRepository(db);
  }, [dbPath]);

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
