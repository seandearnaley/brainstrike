import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migration075FileSymbols } from '../src/migrations/075-file-symbols.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { FileSymbolRepository } from '../src/repositories/file-symbol-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir.js';

describe('migration 075 rollback semantics', () => {
  let db: PGlite;
  let runner: MigrationRunner;
  let repository: FileSymbolRepository;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('rollback-075'));
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations);
    repository = new FileSymbolRepository(db);
    await db.exec(`
      INSERT INTO roots (id, kind, display_name, path)
        VALUES ('rollback-root', 'path', 'root', '/rollback');
      INSERT INTO file_records (id, name, path, size, root_id, content, chunks_processed_at, chunking_strategy, created_at, updated_at)
        VALUES ('rollback-file', 'a.ts', '/rollback/a.ts', 22, 'rollback-root',
                'export function a() {}', '2026-07-27T00:00:00Z', 'fixture', NOW()::text, NOW()::text);
      INSERT INTO file_records (id, name, path, size, root_id, chunks_processed_at, chunking_strategy, created_at, updated_at)
        VALUES ('rollback-unloaded', 'b.ts', '/rollback/b.ts', 0, 'rollback-root',
                '2026-07-27T00:00:00Z', 'fixture', NOW()::text, NOW()::text);
    `);
    await db.exec(`INSERT INTO file_chunks
      (id, file_record_id, chunk_index, content, content_hash, created_at, updated_at)
      VALUES ('rollback-chunk', 'rollback-file', 0, 'export function a() {}',
              'rollback-hash', '2026-07-27T00:00:00Z', '2026-07-27T00:00:00Z')`);
    await insertGraph();
  });

  afterEach(async () => {
    await db.close();
  });

  async function insertGraph(): Promise<void> {
    await repository.insertMany(
      [
        {
          endLine: 1,
          endOffset: 22,
          exported: true,
          fileRecordId: 'rollback-file',
          kind: 'function',
          name: 'a',
          seq: 0,
          startLine: 1,
          startOffset: 0,
        },
      ],
      [
        {
          fileRecordId: 'rollback-file',
          fromSymbolSeq: 0,
          kind: 'call',
          line: 1,
          name: 'callee',
          seq: 0,
        },
      ]
    );
  }

  async function readFiles(): Promise<Record<string, unknown>[]> {
    const result = await db.query<Record<string, unknown>>(
      'SELECT * FROM file_records ORDER BY id'
    );
    return result.rows;
  }

  async function readGraph(): Promise<unknown[]> {
    const result = await db.query(`SELECT s.name AS symbol, r.name AS ref
      FROM file_symbols s JOIN file_symbol_refs r
        ON s.file_record_id = r.file_record_id AND s.seq = r.from_symbol_seq`);
    return result.rows;
  }

  it('drops only the derived graph and schedules its rebuild without losing file content', async () => {
    const files = await readFiles();
    const roots = await db.query('SELECT * FROM roots ORDER BY id');
    const chunks = await db.query('SELECT * FROM file_chunks ORDER BY id');
    await runner.rollback(migration075FileSymbols);
    expect(await runner.isApplied(75)).toBe(false);
    expect(await readFiles()).toEqual(files);
    expect((await db.query('SELECT * FROM file_chunks ORDER BY id')).rows).toEqual(chunks.rows);
    expect((await db.query('SELECT * FROM roots ORDER BY id')).rows).toEqual(roots.rows);
    const absent = await db.query(`SELECT to_regclass('file_symbols') AS symbols,
      to_regclass('file_symbol_refs') AS refs,
      to_regclass('idx_file_symbols_name') AS symbol_index,
      to_regclass('idx_file_symbol_refs_name_kind') AS ref_index`);
    expect(absent.rows).toEqual([
      { ref_index: null, refs: null, symbol_index: null, symbols: null },
    ]);
    if (typeof migration075FileSymbols.down !== 'string') {
      throw new Error('Migration 075 must have a SQL rollback');
    }
    await db.exec(migration075FileSymbols.down);
    await runner.runMigration(migration075FileSymbols);
    expect(await runner.isApplied(75)).toBe(true);
    expect(await readFiles()).toEqual(
      files.map((row) =>
        row['id'] === 'rollback-file'
          ? { ...row, chunking_strategy: null, chunks_processed_at: null }
          : row
      )
    );
    expect((await db.query('SELECT * FROM file_chunks ORDER BY id')).rows).toEqual(chunks.rows);
    expect(await readGraph()).toEqual([]);
    await insertGraph();
    expect(await readGraph()).toEqual([{ ref: 'callee', symbol: 'a' }]);
    await expect(
      db.exec(`INSERT INTO file_symbol_refs
      (file_record_id, seq, from_symbol_seq, name, kind, line)
      VALUES ('rollback-file', 1, 99, 'invalid', 'call', 1)`)
    ).rejects.toThrow('foreign key constraint');
  });

  it('restores earlier drops and the ledger if a dependent view blocks the final DROP', async () => {
    const files = await readFiles();
    await db.exec('CREATE VIEW rollback_symbol_reader AS SELECT name FROM file_symbols');
    await expect(runner.rollback(migration075FileSymbols)).rejects.toThrow(
      'cannot drop table file_symbols because other objects depend on it'
    );
    expect(await runner.isApplied(75)).toBe(true);
    expect(await readFiles()).toEqual(files);
    expect(await readGraph()).toEqual([{ ref: 'callee', symbol: 'a' }]);
    const indexes = await db.query(`SELECT indexname FROM pg_indexes
      WHERE indexname IN ('idx_file_symbols_name', 'idx_file_symbol_refs_name_kind') ORDER BY indexname`);
    expect(indexes.rows).toEqual([
      { indexname: 'idx_file_symbol_refs_name_kind' },
      { indexname: 'idx_file_symbols_name' },
    ]);
    expect((await db.query('SELECT * FROM rollback_symbol_reader')).rows).toEqual([{ name: 'a' }]);
    await db.exec('DROP VIEW rollback_symbol_reader');
    await runner.rollback(migration075FileSymbols);
    expect(await runner.isApplied(75)).toBe(false);
  });
});
