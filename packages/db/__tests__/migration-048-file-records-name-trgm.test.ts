import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

interface IndexRow {
  indexname: string;
}

describe('migration 048: file_records.name trigram index', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-file-records-name-trgm');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
    await runner.initialize();
    // Bring the schema up through migration 047 (file_records + pg_trgm 038 exist).
    await runner.up(migrations.filter((migration) => migration.version < 48));
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration048() {
    const migration = migrations.find((candidate) => candidate.version === 48);
    if (!migration) {
      throw new Error('Migration 048 is missing');
    }
    return migration;
  }

  it('creates the trigram GIN index on file_records.name', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration048());

    const index = await db.query<IndexRow>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'file_records'`
    );
    expect(index.rows.map((row) => row.indexname)).toContain('idx_file_records_name_trgm');
  });

  it('is idempotent (re-running does not throw)', { timeout: 60_000 }, async () => {
    const migration = getMigration048();
    await runner.runMigration(migration);
    // The IF NOT EXISTS guard must let the same migration run on the drizzle path
    // after the numbered runner already created it.
    await expect(db.query(migration.up)).resolves.toBeDefined();
  });

  it('rollback drops the trigram index', { timeout: 60_000 }, async () => {
    const migration = getMigration048();
    await runner.runMigration(migration);
    await runner.rollback(migration);

    const index = await db.query<IndexRow>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'file_records'`
    );
    expect(index.rows.map((row) => row.indexname)).not.toContain('idx_file_records_name_trgm');
  });
});
