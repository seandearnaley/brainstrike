import { BaseFileRecordRepository } from './base-repository.js';
import type { IDatabase } from './interfaces.js';

/**
 * Electron IPC API
 */
export type ElectronDbAPI = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  exec: (sql: string) => Promise<void>;
};

/**
 * Adapter to make ElectronDbAPI compatible with IDatabase interface
 */
class ElectronDbAdapter implements IDatabase {
  constructor(private readonly electronDb: ElectronDbAPI) {}

  async query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    // Only pass params if they are provided
    const result =
      params && params.length > 0
        ? await this.electronDb.query(sql, params)
        : await this.electronDb.query(sql);
    return { rows: result.rows as T[] };
  }
}

/**
 * Electron IPC implementation of FileRecordRepository
 * Used in Electron renderer process to communicate with main process database
 */
export class ElectronFileRecordRepository extends BaseFileRecordRepository {
  constructor(db: ElectronDbAPI) {
    super(new ElectronDbAdapter(db));
  }
}
