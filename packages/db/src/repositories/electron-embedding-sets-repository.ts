import type { ElectronDbAPI } from './electron-file-record-repository.js';
import { EmbeddingSetsRepository } from './embedding-sets-repository.js';

/**
 * Adapter to make ElectronDbAPI compatible with EmbeddingSetsRepository
 *
 * Note: The 'execute' method runs raw SQL statements via Electron IPC.
 * This is NOT child_process.exec - it's database statement execution.
 */
class ElectronEmbeddingSetsDbAdapter {
  constructor(private readonly electronDb: ElectronDbAPI) {}

  /**
   * Execute a SQL statement (DDL/DML without results)
   * Named 'exec' to match the EmbeddingSetsDb interface
   */
  async exec(sql: string, _params?: unknown): Promise<unknown> {
    // ElectronDbAPI.exec runs SQL statements via IPC to main process PGlite
    return this.electronDb.exec(sql);
  }

  async query<T = unknown>(sql: string, params?: unknown): Promise<{ rows: T[] }> {
    const paramsArray = Array.isArray(params) ? params : params ? [params] : [];
    const result =
      paramsArray.length > 0
        ? await this.electronDb.query(sql, paramsArray)
        : await this.electronDb.query(sql);
    return { rows: result.rows as T[] };
  }
}

/**
 * Electron IPC implementation of EmbeddingSetsRepository
 * Used in Electron renderer process to communicate with main process database
 */
export class ElectronEmbeddingSetsRepository extends EmbeddingSetsRepository {
  constructor(db: ElectronDbAPI) {
    super(new ElectronEmbeddingSetsDbAdapter(db));
  }
}
