import type { TransactionStatement } from '../atomic-transaction.js';
import { BaseFileRecordRepository } from './base-repository.js';

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
   * This renderer-facing adapter keeps the historical `transaction` name, but its
   * shape is the desktop statement-list capability (the preload calls it
   * `runTransaction`), not a callback transaction. Callers that require atomic
   * multi-statement work must reject when it is absent; separate BEGIN/COMMIT IPC
   * calls cannot hold the main-process connection lock.
   * Reuses {@link TransactionStatement} (the single source of truth, also used by
   * `runStatementsInTransaction`) rather than redeclaring the `{ sql, params }` shape.
   */
  transaction?: (
    statements: TransactionStatement[],
    resultIndex: number
  ) => Promise<{ rows: unknown[] }>;
}

/**
 * Adapter to make ElectronDbAPI compatible with the file-record database seam.
 */
class ElectronDbAdapter {
  constructor(private readonly electronDb: ElectronDbAPI) {}

  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    // Only pass params if they are provided
    const result =
      params && params.length > 0
        ? await this.electronDb.query(sql, params)
        : await this.electronDb.query(sql);
    return { rows: result.rows };
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
