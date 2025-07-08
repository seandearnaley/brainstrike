import type { FileImportRequest, FileImportResult, FileRecord } from '../models/file-record.js';
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
  'content',
  'contentHash',
  'tokenCount',
  'processedAt',
  'embedding',
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

  async createWithContent(record: FileRecord): Promise<void> {
    const fields = [
      'id',
      'name',
      'path',
      'size',
      'created_at',
      'updated_at',
      'content',
      'content_hash',
      'token_count',
      'processed_at',
    ];
    const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `INSERT INTO ${this.tableName} (${fields.join(', ')}) VALUES (${placeholders})`;

    await this.db.query(sql, [
      record.id,
      record.name,
      record.path,
      record.size,
      record.createdAt,
      record.updatedAt,
      record.content || null,
      record.contentHash || null,
      record.tokenCount || 0,
      record.processedAt || null,
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

  async findByContentHash(contentHash: string): Promise<FileRecord | null> {
    const sql = `SELECT * FROM ${this.tableName} WHERE content_hash = $1`;
    const result = await this.db.query(sql, [contentHash]);
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

  async findAllWithContent(): Promise<FileRecord[]> {
    const sql = `SELECT * FROM ${this.tableName} WHERE content IS NOT NULL ORDER BY processed_at DESC, updated_at DESC`;
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

  async updateContent(
    id: string,
    content: string,
    contentHash: string,
    tokenCount: number
  ): Promise<void> {
    const now = new Date().toISOString();
    const sql = `UPDATE ${this.tableName} SET content = $1, content_hash = $2, token_count = $3, processed_at = $4, updated_at = $5 WHERE id = $6`;
    await this.db.query(sql, [content, contentHash, tokenCount, now, now, id]);
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
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
    return Number(countRow['count'] || 0);
  }

  async countWithContent(): Promise<number> {
    const sql = `SELECT COUNT(*) as count FROM ${this.tableName} WHERE content IS NOT NULL`;
    const result = await this.db.query(sql);
    const row = result.rows[0];

    if (!row || typeof row !== 'object') {
      return 0;
    }

    const countRow = row as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
    return Number(countRow['count'] || 0);
  }

  async bulkImport(
    requests: FileImportRequest[],
    onProgress?: (completed: number, total: number, current?: string) => void
  ): Promise<FileImportResult[]> {
    const results: FileImportResult[] = [];

    for (let i = 0; i < requests.length; i++) {
      const request = requests[i];
      if (!request) continue;

      onProgress?.(i, requests.length, request.name);

      try {
        // Generate content hash for deduplication
        const contentHash = await this.generateContentHash(request.content);

        // Check if file with same content already exists
        const existing = await this.findByContentHash(contentHash);

        if (existing) {
          results.push({
            id: existing.id,
            imported: false,
            existed: true,
          });
          continue;
        }

        // Count tokens
        const tokenCount = this.countTokensHeuristic(request.content);

        // Create new record
        const now = new Date().toISOString();
        const id = crypto.randomUUID();

        const record: FileRecord = {
          id,
          name: request.name,
          path: request.path,
          size: request.size,
          createdAt: now,
          updatedAt: now,
          content: request.content,
          contentHash,
          tokenCount,
          processedAt: now,
        };

        await this.createWithContent(record);

        results.push({
          id,
          imported: true,
          existed: false,
        });
      } catch (error) {
        results.push({
          id: '',
          imported: false,
          existed: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    onProgress?.(requests.length, requests.length);
    return results;
  }

  /**
   * Generate SHA-256 hash of content for deduplication
   */
  private async generateContentHash(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Simple heuristic token counting (4 chars per token)
   */
  private countTokensHeuristic(content: string): number {
    return Math.ceil(content.length / 4);
  }

  /**
   * Maps database row to domain model
   * Uses bracket notation for type safety with unknown records
   */
  protected fromRow(row: Record<string, unknown>): FileRecord {
    const record: FileRecord = {
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
      id: String(row['id']),
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
      name: String(row['name']),
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
      path: String(row['path']),
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
      size: Number(row['size']),
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
      createdAt: String(row['created_at']),
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
      updatedAt: String(row['updated_at']),
    };

    // Add optional fields if they exist
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
    if (row['content'] != null) {
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
      record.content = String(row['content']);
    }
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
    if (row['content_hash'] != null) {
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
      record.contentHash = String(row['content_hash']);
    }
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
    if (row['token_count'] != null) {
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
      record.tokenCount = Number(row['token_count']);
    }
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
    if (row['processed_at'] != null) {
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
      record.processedAt = String(row['processed_at']);
    }
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
    if (row['embedding'] != null) {
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
      record.embedding = row['embedding'] as number[];
    }

    return record;
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
      case 'contentHash':
        return 'content_hash';
      case 'tokenCount':
        return 'token_count';
      case 'processedAt':
        return 'processed_at';
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
