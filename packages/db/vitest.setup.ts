import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, vi } from 'vitest';

const memoryDir = resolve(__dirname, ':memory:');

function cleanup() {
  if (existsSync(memoryDir)) {
    rmSync(memoryDir, { recursive: true, force: true });
  }
}

// Check if we're in CI environment that has WASM issues
const isCI = process.env.CI === 'true';

// Mock PGlite to prevent WASM issues in CI
class MockPGlite {
  private _closed = false;
  private _tables = new Map<string, { rows: unknown[]; schema: Record<string, string> }>();
  private _lastInsertId = 0;
  
  constructor(config?: unknown) {
    void config;
    this._closed = false;
    
    // Initialize common tables for testing
    this._tables.set('file_records', { rows: [], schema: { id: 'number', path: 'string' } });
    this._tables.set('file_chunks', { rows: [], schema: { id: 'number', file_record_id: 'number', content: 'string' } });
    this._tables.set('migrations', { rows: [], schema: { version: 'number', name: 'string' } });
  }

  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; fields: unknown[] }> {
    if (this._closed) {
      throw new Error('Database connection is closed');
    }
    
    // Handle specific test queries
    if (sql.includes('SELECT 1 AS value')) {
      return { rows: [{ value: 1 }], fields: [] };
    }
    
    if (sql.includes('SELECT 1')) {
      return { rows: [{ '?column?': 1 }], fields: [] };
    }
    
    if (sql.includes('CREATE TABLE')) {
      return { rows: [], fields: [] };
    }
    
    if (sql.includes('INSERT INTO')) {
      this._lastInsertId++;
      return { rows: [], fields: [] };
    }
    
    if (sql.includes('SELECT') && sql.includes('FROM')) {
      const tableName = this.extractTableName(sql);
      const table = this._tables.get(tableName);
      return { rows: table?.rows || [], fields: [] };
    }
    
    return { rows: [], fields: [] };
  }

  async exec(sql: string): Promise<{ rows: unknown[]; fields: unknown[] }[]> {
    return [await this.query(sql)];
  }

  async close(): Promise<void> {
    this._closed = true;
  }

  private extractTableName(sql: string): string {
    const match = sql.match(/FROM\s+(\w+)/i);
    return match ? match[1] : 'default';
  }
}

// Only mock PGlite in CI environment to prevent WASM issues
if (isCI) {
  // Mock the @electric-sql/pglite module
  vi.mock('@electric-sql/pglite', () => ({
    PGlite: MockPGlite,
  }));

  // Mock the vector extension
  vi.mock('@electric-sql/pglite/vector', () => ({
    vector: null,
  }));
}

beforeAll(() => {
  // Disable vector extensions in test environment
  process.env.DISABLE_VECTOR_EXTENSION = 'true';
  
  if (isCI) {
    console.log('🚨 Running in CI: PGlite is mocked to prevent WASM issues');
  }
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 1000));
  cleanup();
});
