import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

interface ColumnRow {
  column_name: string;
  is_nullable: string;
}

interface IndexRow {
  indexname: string;
}

describe('migration 047: assistant run usage root_id', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-run-usage-root-id');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
    await runner.initialize();
    // Bring the schema up through migration 046 (the table this migration alters).
    await runner.up(migrations.filter((migration) => migration.version < 47));
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration047() {
    const migration = migrations.find((candidate) => candidate.version === 47);
    if (!migration) {
      throw new Error('Migration 047 is missing');
    }
    return migration;
  }

  it('adds a nullable root_id column and the resource/root index', {
    timeout: 60_000,
  }, async () => {
    await runner.runMigration(getMigration047());

    const column = await db.query<ColumnRow>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'brainstrike_assistant_run_usage' AND column_name = 'root_id'`
    );
    expect(column.rows[0]?.column_name).toBe('root_id');
    expect(column.rows[0]?.is_nullable).toBe('YES');

    const index = await db.query<IndexRow>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'brainstrike_assistant_run_usage'`
    );
    expect(index.rows.map((row) => row.indexname)).toContain(
      'brainstrike_assistant_run_usage_root_idx'
    );
  });

  it('accepts rows with a null root_id (honest "unattributed")', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration047());

    await db.query(
      `INSERT INTO brainstrike_assistant_run_usage
        (id, thread_id, run_id, resource_id, model, provider, input_tokens, output_tokens, root_id)
       VALUES
        ('u1', 'thread-1', 'run-1', 'workspace-a', 'gpt-5.2', 'openai', 100, 50, 'root-a'),
        ('u2', 'thread-1', 'run-2', 'workspace-a', 'gpt-5.2', 'openai', 200, 75, NULL)`
    );

    const rows = await db.query<{ id: string; root_id: string | null }>(
      'SELECT id, root_id FROM brainstrike_assistant_run_usage ORDER BY id'
    );
    expect(rows.rows).toEqual([
      { id: 'u1', root_id: 'root-a' },
      { id: 'u2', root_id: null },
    ]);
  });

  it('rollback drops the root index and column', { timeout: 60_000 }, async () => {
    const migration = getMigration047();
    await runner.runMigration(migration);
    await runner.rollback(migration);

    const column = await db.query<ColumnRow>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'brainstrike_assistant_run_usage' AND column_name = 'root_id'`
    );
    expect(column.rows).toHaveLength(0);

    const index = await db.query<IndexRow>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'brainstrike_assistant_run_usage'`
    );
    expect(index.rows.map((row) => row.indexname)).not.toContain(
      'brainstrike_assistant_run_usage_root_idx'
    );
  });
});
