import type { TransactionStatement } from '../atomic-transaction.js';
import { BaseFileRecordRepository } from './base-repository.js';
import type { IDatabase } from './interfaces.js';

/**
 * Electron IPC API
 */
export interface ElectronDbAPI {
  exec: (sql: string) => Promise<void>;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  /**
   * Run an ordered list of statements inside a SINGLE `pglite.transaction()` in the
   * MAIN process and return the rows of `statements[resultIndex]`. Atomic over IPC:
   * because PGlite's `transaction()` holds the single-connection lock, a concurrent
   * `query()` (e.g. the FTS half of HybridSearchService's `Promise.all`) cannot
   * interleave into the block — fixing the isolation/error-coupling hazard that raw
   * `BEGIN`/`COMMIT` over separate IPC calls leaves open (#1141).
   *
   * Optional: the real desktop preload provides it; older or mocked `ElectronDbAPI`
   * implementations may not, in which case callers fall back to raw BEGIN/COMMIT.
   * Reuses {@link TransactionStatement} (the single source of truth, also used by
   * `runStatementsInTransaction`) rather than redeclaring the `{ sql, params }` shape.
   */
  transaction?: (
    statements: TransactionStatement[],
    resultIndex: number
  ) => Promise<{ rows: unknown[] }>;
}

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
