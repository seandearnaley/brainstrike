import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

interface CountRow {
  count: number | string;
}

interface IndexRow {
  indexname: string;
}

describe('migration 046: assistant run usage table', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-assistant-run-usage');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 46));
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration046() {
    const migration = migrations.find((candidate) => candidate.version === 46);
    if (!migration) {
      throw new Error('Migration 046 is missing');
    }
    return migration;
  }

  it('creates the run-usage table and thread index', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration046());

    const table = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_name = 'brainstrike_assistant_run_usage'`
    );
    expect(Number(table.rows[0]?.count ?? 0)).toBe(1);

    const index = await db.query<IndexRow>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'brainstrike_assistant_run_usage'`
    );
    expect(index.rows.map((row) => row.indexname)).toContain('idx_run_usage_thread');
  });

  it('stores model/provider per row so per-model attribution survives', {
    timeout: 60_000,
  }, async () => {
    await runner.runMigration(getMigration046());

    await db.query(
      `INSERT INTO brainstrike_assistant_run_usage
        (id, thread_id, run_id, resource_id, model, provider, input_tokens, output_tokens)
       VALUES
        ('u1', 'thread-1', 'run-1', 'workspace-a', 'gpt-5.2', 'openai', 100, 50),
        ('u2', 'thread-1', 'run-2', 'workspace-a', 'claude-opus-4-8', 'anthropic', 200, 75)`
    );

    const rows = await db.query<{
      model: string;
      provider: string;
      input_tokens: number;
      output_tokens: number;
    }>(
      `SELECT model, provider, input_tokens, output_tokens
       FROM brainstrike_assistant_run_usage
       WHERE thread_id = 'thread-1'
       ORDER BY id`
    );
    expect(rows.rows).toEqual([
      { model: 'gpt-5.2', provider: 'openai', input_tokens: 100, output_tokens: 50 },
      { model: 'claude-opus-4-8', provider: 'anthropic', input_tokens: 200, output_tokens: 75 },
    ]);

    const totals = await db.query<{ in_total: number | string; out_total: number | string }>(
      `SELECT SUM(input_tokens) AS in_total, SUM(output_tokens) AS out_total
       FROM brainstrike_assistant_run_usage
       WHERE thread_id = 'thread-1'`
    );
    expect(Number(totals.rows[0]?.in_total ?? 0)).toBe(300);
    expect(Number(totals.rows[0]?.out_total ?? 0)).toBe(125);
  });

  it('rejects negative token counts via the CHECK constraint', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration046());

    await expect(
      db.query(
        `INSERT INTO brainstrike_assistant_run_usage
          (id, thread_id, run_id, resource_id, model, provider, input_tokens, output_tokens)
         VALUES ('bad', 'thread-1', 'run-1', 'workspace-a', 'gpt-5.2', 'openai', -1, 0)`
      )
    ).rejects.toThrow();
  });

  it('rollback drops the table and index', { timeout: 60_000 }, async () => {
    const migration = getMigration046();
    await runner.runMigration(migration);
    await runner.rollback(migration);

    const table = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_name = 'brainstrike_assistant_run_usage'`
    );
    expect(Number(table.rows[0]?.count ?? -1)).toBe(0);
  });
});
