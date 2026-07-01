import type { TransactionStatement } from '../atomic-transaction.js';
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

  async transaction<T>(): Promise<T> {
    throw new Error(
      'ElectronEmbeddingSetsDbAdapter does not support callback transactions. Use ElectronEmbeddingSetsRepository methods backed by the atomic IPC transaction primitive.'
    );
  }
}

/**
 * Electron IPC implementation of EmbeddingSetsRepository
 * Used in Electron renderer process to communicate with main process database
 */
export class ElectronEmbeddingSetsRepository extends EmbeddingSetsRepository {
  constructor(private readonly electronDb: ElectronDbAPI) {
    super(new ElectronEmbeddingSetsDbAdapter(electronDb));
  }

  override async delete(id: string): Promise<boolean> {
    if (!this.electronDb.transaction) {
      throw new Error(
        'Electron embedding set deletion requires the atomic database transaction IPC channel.'
      );
    }

    const existing = await this.electronDb.query('SELECT id FROM embedding_sets WHERE id = $1', [
      id,
    ]);
    if (existing.rows.length === 0) {
      return false;
    }

    const statements: TransactionStatement[] = [
      { sql: 'DELETE FROM job_queue WHERE embedding_set_id = $1', params: [id] },
      { sql: 'DELETE FROM collection_indexing_stats WHERE embedding_set_id = $1', params: [id] },
      {
        sql: `DELETE FROM file_chunks
          WHERE embedding_set_id = $1
             OR (
               embedding_set_id IS NULL
               AND EXISTS (
                 SELECT 1
                   FROM file_records fr
                  WHERE fr.id = file_chunks.file_record_id
                    AND fr.embedding_set_id = $1
               )
             )`,
        params: [id],
      },
      {
        sql: `UPDATE file_records
            SET embedding_set_id = NULL,
                chunks_processed_at = NULL,
                chunks_count = NULL,
                chunking_strategy = NULL
          WHERE embedding_set_id = $1`,
        params: [id],
      },
      { sql: 'DELETE FROM embedding_sets WHERE id = $1 RETURNING id', params: [id] },
    ];
    const result = await this.electronDb.transaction(statements, 4);
    return result.rows.length > 0;
  }
}
