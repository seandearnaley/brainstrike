import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

interface CountRow {
  count: number | string;
}

interface ColumnRow {
  column_name: string;
}

describe('migration 063: job queue outcome metrics columns', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-job-queue-outcome-metrics');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 63));
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration063() {
    const migration = migrations.find((candidate) => candidate.version === 63);
    if (!migration) {
      throw new Error('Migration 063 is missing');
    }
    return migration;
  }

  it('adds failed_total and canceled_total columns to job_queue_metrics', {
    timeout: 60_000,
  }, async () => {
    await runner.runMigration(getMigration063());

    const columns = await db.query<ColumnRow>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'job_queue_metrics'`
    );
    const columnNames = columns.rows.map((row) => row.column_name);
    expect(columnNames).toContain('succeeded_total');
    expect(columnNames).toContain('failed_total');
    expect(columnNames).toContain('canceled_total');
  });

  it('defaults new counters to zero and supports atomic increments', {
    timeout: 60_000,
  }, async () => {
    await runner.runMigration(getMigration063());

    await db.query("INSERT INTO job_queue_metrics (queue) VALUES ('embeddings')");
    const defaults = await db.query<{
      canceled_total: number | string;
      failed_total: number | string;
    }>("SELECT failed_total, canceled_total FROM job_queue_metrics WHERE queue = 'embeddings'");
    expect(Number(defaults.rows[0]?.failed_total ?? -1)).toBe(0);
    expect(Number(defaults.rows[0]?.canceled_total ?? -1)).toBe(0);

    await db.query(
      `INSERT INTO job_queue_metrics (queue, failed_total, canceled_total)
       VALUES ('embeddings', 2, 3)
       ON CONFLICT (queue) DO UPDATE
         SET failed_total = job_queue_metrics.failed_total + EXCLUDED.failed_total,
             canceled_total = job_queue_metrics.canceled_total + EXCLUDED.canceled_total`
    );
    const incremented = await db.query<{
      canceled_total: number | string;
      failed_total: number | string;
    }>("SELECT failed_total, canceled_total FROM job_queue_metrics WHERE queue = 'embeddings'");
    expect(Number(incremented.rows[0]?.failed_total ?? -1)).toBe(2);
    expect(Number(incremented.rows[0]?.canceled_total ?? -1)).toBe(3);
  });

  it('rollback drops the outcome columns but keeps the table', { timeout: 60_000 }, async () => {
    const migration = getMigration063();
    await runner.runMigration(migration);
    await runner.rollback(migration);

    const table = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_name = 'job_queue_metrics'`
    );
    expect(Number(table.rows[0]?.count ?? 0)).toBe(1);

    const columns = await db.query<ColumnRow>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'job_queue_metrics'`
    );
    const columnNames = columns.rows.map((row) => row.column_name);
    expect(columnNames).toContain('succeeded_total');
    expect(columnNames).not.toContain('failed_total');
    expect(columnNames).not.toContain('canceled_total');
  });
});
