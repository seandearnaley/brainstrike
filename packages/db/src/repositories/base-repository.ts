import type { FileRecord } from '../models/file-record.js';
import type { IDatabase, IFileRecordRepository } from './interfaces.js';

/**
 * Allowed fields for updates - prevents accidental ID updates
 */
const ALLOWED_UPDATE_FIELDS: readonly (keyof FileRecord)[] = [
  'name',
  'path',
  'size',
  'createdAt',
  'updatedAt',
] as const;

/**
 * Base repository with shared SQL generation and mapping logic
 */
export abstract class BaseFileRecordRepository implements IFileRecordRepository {
  protected readonly tableName = 'file_records';

  constructor(protected db: IDatabase) {}

  async create(record: FileRecord): Promise<void> {
    const fields = ['id', 'name', 'path', 'size', 'created_at', 'updated_at'];
    const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `INSERT INTO ${this.tableName} (${fields.join(', ')}) VALUES (${placeholders})`;

    await this.db.query(sql, [
      record.id,
      record.name,
      record.path,
      record.size,
      record.createdAt,
      record.updatedAt,
    ]);
  }

  async findById(id: string): Promise<FileRecord | null> {
    const sql = `SELECT * FROM ${this.tableName} WHERE id = $1`;
    const result = await this.db.query(sql, [id]);
    const row = result.rows[0];

    if (!row || typeof row !== 'object' || row === null) {
      return null;
    }

    return this.fromRow(row as Record<string, unknown>);
  }

  async findAll(): Promise<FileRecord[]> {
    const sql = `SELECT * FROM ${this.tableName} ORDER BY updated_at DESC`;
    const result = await this.db.query<Record<string, unknown>>(sql);

    if (!Array.isArray(result.rows)) {
      return [];
    }

    return result.rows
      .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
      .map((row) => this.fromRow(row));
  }

  async update(id: string, updates: Partial<FileRecord>): Promise<void> {
    const fields = Object.keys(updates).filter((k): k is keyof FileRecord =>
      ALLOWED_UPDATE_FIELDS.includes(k as keyof FileRecord)
    );

    if (fields.length === 0) {
      return;
    }

    const updatesObj = updates as Record<string, unknown>;
    const values = fields.map((f) => updatesObj[f]);
    values.push(id);

    const setClause = fields.map((f, i) => `${this.toDbField(f)} = $${i + 1}`).join(', ');

    const sql = `UPDATE ${this.tableName} SET ${setClause} WHERE id = $${fields.length + 1}`;
    await this.db.query(sql, values);
  }

  async delete(id: string): Promise<void> {
    const sql = `DELETE FROM ${this.tableName} WHERE id = $1`;
    await this.db.query(sql, [id]);
  }

  async count(): Promise<number> {
    const sql = `SELECT COUNT(*) as count FROM ${this.tableName}`;
    const result = await this.db.query(sql);
    const row = result.rows[0];

    if (!row || typeof row !== 'object') {
      return 0;
    }

    const countRow = row as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: index signature access
    return Number(countRow['count'] || 0);
  }

  /**
   * Maps database row to domain model
   * Uses bracket notation for type safety with unknown records
   */
  protected fromRow(row: Record<string, unknown>): FileRecord {
    return {
      // biome-ignore lint/complexity/useLiteralKeys: index signature access
      id: String(row['id']),
      // biome-ignore lint/complexity/useLiteralKeys: index signature access
      name: String(row['name']),
      // biome-ignore lint/complexity/useLiteralKeys: index signature access
      path: String(row['path']),
      // biome-ignore lint/complexity/useLiteralKeys: index signature access
      size: Number(row['size']),
      // biome-ignore lint/complexity/useLiteralKeys: index signature access
      createdAt: String(row['created_at']),
      // biome-ignore lint/complexity/useLiteralKeys: index signature access
      updatedAt: String(row['updated_at']),
    };
  }

  /**
   * Maps domain field names to database column names
   */
  protected toDbField(field: string): string {
    switch (field) {
      case 'createdAt':
        return 'created_at';
      case 'updatedAt':
        return 'updated_at';
      default:
        return field;
    }
  }

  /**
   * Generic query builder helpers for extended functionality
   */
  protected buildWhereClause(
    conditions: Record<string, unknown>,
    startIndex = 1
  ): { clause: string; values: unknown[] } {
    const entries = Object.entries(conditions);
    if (entries.length === 0) {
      return { clause: '', values: [] };
    }

    const clauses = entries.map(([field, _], i) => `${this.toDbField(field)} = $${startIndex + i}`);
    const values = entries.map(([_, value]) => value);

    return {
      clause: `WHERE ${clauses.join(' AND ')}`,
      values,
    };
  }
}
