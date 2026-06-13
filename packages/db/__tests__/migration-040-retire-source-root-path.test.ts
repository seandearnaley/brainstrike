import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

interface FileRecordRootRow {
  id: string;
  root_id: string | null;
}

interface ColumnRow {
  column_name: string;
}

interface IndexRow {
  indexname: string;
}

const SEED_TS = '2026-06-13T00:00:00.000Z';

describe('migration 040: retire source_root_path', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-retire-source-root-path');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
    await runner.initialize();
    // Stop BEFORE 040 so source_root_path + the 029 indexes still exist.
    await runner.up(migrations.filter((migration) => migration.version < 40));
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration040() {
    const migration = migrations.find((candidate) => candidate.version === 40);
    if (!migration) {
      throw new Error('Migration 040 is missing');
    }
    return migration;
  }

  async function seedRoot(id: string, path: string): Promise<void> {
    await db.query(`INSERT INTO roots (id, kind, display_name, path) VALUES ($1, 'path', $2, $3)`, [
      id,
      path.split('/').pop() ?? path,
      path,
    ]);
  }

  async function seedFileRecord(args: {
    id: string;
    path: string;
    sourceRootPath: string;
    rootId: string | null;
  }): Promise<void> {
    await db.query(
      `INSERT INTO file_records (id, name, path, size, source_root_path, root_id, embedding_set_id, created_at, updated_at)
       VALUES ($1, $2, $3, 0, $4, $5, NULL, $6, $6)`,
      [
        args.id,
        args.path.split('/').pop() ?? args.path,
        args.path,
        args.sourceRootPath,
        args.rootId,
        SEED_TS,
      ]
    );
  }

  it('backfills null root_id from source_root_path before dropping the column', async () => {
    await seedRoot('root-1', '/Users/me/project');
    // A row written before the import path guaranteed root_id — has the path
    // but no id yet. Trailing separator must still match the normalized root.
    await seedFileRecord({
      id: 'needs-backfill',
      path: 'src/index.ts',
      sourceRootPath: '/Users/me/project/',
      rootId: null,
    });
    // A row that already carries its root_id stays untouched.
    await seedFileRecord({
      id: 'already-mapped',
      path: 'src/app.ts',
      sourceRootPath: '/Users/me/project',
      rootId: 'root-1',
    });

    await runner.up([getMigration040()]);

    const rows = await db.query<FileRecordRootRow>(
      'SELECT id, root_id FROM file_records ORDER BY id'
    );
    expect(rows.rows).toEqual([
      { id: 'already-mapped', root_id: 'root-1' },
      { id: 'needs-backfill', root_id: 'root-1' },
    ]);
  });

  it('backfills when roots.path itself carries a trailing separator (039 stores it raw)', async () => {
    // 039 inserts roots.path = the RAW source_root_path (only display_name is
    // trimmed), so a root first seen from '/x/' has roots.path = '/x/'. The
    // backfill must trim BOTH sides — a one-sided trim leaves these rows with
    // root_id NULL, silently dropping them from the managed cache.
    await seedRoot('root-trailing', '/Users/me/trailing/');
    // Source carries the trailing separator too (matches roots.path verbatim,
    // but both must still normalize equal).
    await seedFileRecord({
      id: 'trailing-both',
      path: 'src/main.ts',
      sourceRootPath: '/Users/me/trailing/',
      rootId: null,
    });
    // Source has NO trailing separator while the root was stored WITH one —
    // only a symmetric trim resolves this.
    await seedFileRecord({
      id: 'trailing-root-only',
      path: 'src/other.ts',
      sourceRootPath: '/Users/me/trailing',
      rootId: null,
    });

    await runner.up([getMigration040()]);

    const rows = await db.query<FileRecordRootRow>(
      "SELECT id, root_id FROM file_records WHERE id LIKE 'trailing-%' ORDER BY id"
    );
    expect(rows.rows).toEqual([
      { id: 'trailing-both', root_id: 'root-trailing' },
      { id: 'trailing-root-only', root_id: 'root-trailing' },
    ]);
  });

  it('drops the source_root_path column and the 029 indexes, keeps the 039 root_id index', async () => {
    await runner.up([getMigration040()]);

    const columns = await db.query<ColumnRow>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'file_records'`
    );
    const columnNames = columns.rows.map((row) => row.column_name);
    expect(columnNames).not.toContain('source_root_path');
    expect(columnNames).toContain('root_id');

    const indexes = await db.query<IndexRow>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'file_records'`
    );
    const indexNames = indexes.rows.map((row) => row.indexname);
    expect(indexNames).not.toContain('idx_file_records_cache_identity');
    expect(indexNames).not.toContain('idx_file_records_source_root_path');
    expect(indexNames).toContain('idx_file_records_root_identity');
  });

  it('is idempotent when re-applied (down then up)', async () => {
    await runner.up([getMigration040()]);
    // down re-adds the column + 029 indexes; up drops them again without error.
    await runner.down([getMigration040()]);
    await runner.up([getMigration040()]);

    const columns = await db.query<ColumnRow>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'file_records'`
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain('source_root_path');
  });
});
