import { FileRecordRepository } from '@brainstrike/db';
import { PGlite } from '@electric-sql/pglite';
import type React from 'react';
import { createContext, useContext, useMemo } from 'react';

// Desktop: use file-backed DB for persistent storage
const db = new PGlite('desktop.db');
const fileRecordRepository = new FileRecordRepository(db);

interface DbContextValue {
  fileRecordRepository: FileRecordRepository;
}

const DbContext = createContext<DbContextValue | undefined>(undefined);

export const DbProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const value = useMemo(() => ({ fileRecordRepository }), []);
  return <DbContext.Provider value={value}>{children}</DbContext.Provider>;
};

export function useFileRecordRepository(): FileRecordRepository {
  const ctx = useContext(DbContext);
  if (!ctx) throw new Error('useFileRecordRepository must be used within a DbProvider');
  return ctx.fileRecordRepository;
}
