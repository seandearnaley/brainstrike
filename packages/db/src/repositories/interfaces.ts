import type { FileImportRequest, FileImportResult, FileRecord } from '../models/file-record';

/**
 * Common interface for all file record repositories
 */
export interface IFileRecordRepository {
  create(record: FileRecord): Promise<void>;
  createWithContent(record: FileRecord): Promise<void>;
  findById(id: string): Promise<FileRecord | null>;
  findByContentHash(contentHash: string): Promise<FileRecord | null>;
  findAll(): Promise<FileRecord[]>;
  findAllWithContent(): Promise<FileRecord[]>;
  update(id: string, updates: Partial<FileRecord>): Promise<void>;
  updateContent(
    id: string,
    content: string,
    contentHash: string,
    tokenCount: number
  ): Promise<void>;
  delete(id: string): Promise<void>;
  count?(): Promise<number>;
  countWithContent?(): Promise<number>;
  bulkImport?(
    requests: FileImportRequest[],
    onProgress?: (completed: number, total: number, current?: string) => void
  ): Promise<FileImportResult[]>;
  clearAll?(): Promise<number>;
}

/**
 * Minimal database query interface that both PGlite and Electron API implement
 * This is a subset of PGlite's full interface to support both implementations
 */
export interface IDatabase {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
