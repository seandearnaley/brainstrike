import type { PGlite } from '@electric-sql/pglite';
import type { FileRecord } from '../models/file-record';

export class FileRecordRepository {
  constructor(private db: PGlite) {}

  async create(record: FileRecord): Promise<void> {
    await this.db.query(
      'INSERT INTO file_records (id, name, path, size, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [record.id, record.name, record.path, record.size, record.createdAt, record.updatedAt]
    );
  }

  async findById(id: string): Promise<FileRecord | null> {
    const result = await this.db.query('SELECT * FROM file_records WHERE id = $1', [id]);
    const row = result.rows[0];
    if (!row || typeof row !== 'object' || row === null) return null;
    return this.fromRow(row as Record<string, unknown>);
  }

  async findAll(): Promise<FileRecord[]> {
    const result = await this.db.query('SELECT * FROM file_records');
    if (!Array.isArray(result.rows)) return [];
    // Defensive: only map if each row is an object with expected keys
    return result.rows
      .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
      .map((row) => this.fromRow(row));
  }

  async update(id: string, updates: Partial<FileRecord>): Promise<void> {
    const fields = Object.keys(updates).filter((k) => k !== 'id');
    if (fields.length === 0) return;
    const updatesObj = updates as Record<string, unknown>;
    const values = fields.map((f) => updatesObj[f]);
    values.push(id);
    const setClausePG = fields.map((f, i) => `${this.toDbField(f)} = $${i + 1}`).join(', ');
    // id param is always $n+1
    await this.db.query(
      `UPDATE file_records SET ${setClausePG} WHERE id = $${fields.length + 1}`,
      values
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.query('DELETE FROM file_records WHERE id = $1', [id]);
  }

  // NOTE: We use bracket notation for DB row mapping to satisfy TypeScript’s index signature safety.
  // Biome stylistic rule is suppressed for these lines only.
  private fromRow(row: Record<string, unknown>): FileRecord {
    return {
      // biome-ignore lint/complexity/useLiteralKeys: index signature access
      id: String(row['id']), // biome-ignore lint/complexity/useLiteralKeys: index signature access
      name: String(row['name']), // biome-ignore lint/complexity/useLiteralKeys: index signature access
      path: String(row['path']), // biome-ignore lint/complexity/useLiteralKeys: index signature access
      size: Number(row['size']), // biome-ignore lint/complexity/useLiteralKeys: index signature access
      createdAt: String(row['created_at']), // biome-ignore lint/complexity/useLiteralKeys: index signature access
      updatedAt: String(row['updated_at']), // biome-ignore lint/complexity/useLiteralKeys: index signature access
    };
  }

  private toDbField(field: string): string {
    // Map camelCase TS fields to snake_case DB columns
    switch (field) {
      case 'createdAt':
        return 'created_at';
      case 'updatedAt':
        return 'updated_at';
      default:
        return field;
    }
  }
}
