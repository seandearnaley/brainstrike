import type { FileRecord } from '../models/file-record';

/**
 * Common interface for all file record repositories
 */
export interface IFileRecordRepository {
  create(record: FileRecord): Promise<void>;
  findById(id: string): Promise<FileRecord | null>;
  findAll(): Promise<FileRecord[]>;
  update(id: string, updates: Partial<FileRecord>): Promise<void>;
  delete(id: string): Promise<void>;
  count?(): Promise<number>;
}

/**
 * Minimal database query interface that both PGlite and Electron API implement
 * This is a subset of PGlite's full interface to support both implementations
 */
export interface IDatabase {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
