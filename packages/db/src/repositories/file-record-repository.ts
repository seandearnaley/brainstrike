import type { PGlite } from '@electric-sql/pglite';
import { BaseFileRecordRepository } from './base-repository.js';
import type { IDatabase } from './interfaces.js';

/**
 * Adapter to make PGlite compatible with IDatabase interface
 */
class PGliteAdapter implements IDatabase {
  constructor(private pgLite: PGlite) {}

  async query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    const result = await this.pgLite.query<T>(sql, params || []);
    return { rows: result.rows };
  }
}

/**
 * PGlite implementation of FileRecordRepository
 * Used for direct database access in web and Node.js environments
 */
export class FileRecordRepository extends BaseFileRecordRepository {
  constructor(db: PGlite) {
    super(new PGliteAdapter(db));
  }
}
