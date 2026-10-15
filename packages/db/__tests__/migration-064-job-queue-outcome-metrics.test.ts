import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { createDbAtVersion } from './helpers/migrated-test-db.js';

interface CountRow {
  count: number | string;
}

interface ColumnRow {
  column_name: string;
}

describe('migration 064: job queue outcome metrics columns', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await createDbAtVersion(63);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration064() {
    const migration = migrations.find((candidate) => candidate.version === 64);
    if (!migration) {
      throw new Error('Migration 064 is missing');
    }
    return migration;
  }

  it('adds failed_total and canceled_total columns to job_queue_metrics', {
    timeout: 60_000,
  }, async () => {
    await runner.runMigration(getMigration064());

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
    await runner.runMigration(getMigration064());

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
    const migration = getMigration064();
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

  it('backfills lifetime counters from pre-existing terminal rows', {
    timeout: 60_000,
  }, async () => {
    // Terminal rows written BEFORE the counters existed must seed the lifetime
    // totals, or the next maintenance prune erases that history (review #1696).
    await db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state)
       VALUES
        ('bf-1', 'embedding', 'embed-chunk', '{}'::jsonb, 'failed'),
        ('bf-2', 'embedding', 'embed-chunk', '{}'::jsonb, 'failed'),
        ('bf-3', 'embedding', 'embed-chunk', '{}'::jsonb, 'canceled'),
        ('bf-4', 'maintenance', 'vacuum', '{}'::jsonb, 'canceled'),
        ('bf-5', 'embedding', 'embed-chunk', '{}'::jsonb, 'succeeded')`
    );

    await runner.runMigration(getMigration064());

    const seeded = await db.query<{
      queue: string;
      failed_total: number | string;
      canceled_total: number | string;
    }>('SELECT queue, failed_total, canceled_total FROM job_queue_metrics ORDER BY queue');
    expect(
      seeded.rows.map((row) => ({
        canceled: Number(row.canceled_total),
        failed: Number(row.failed_total),
        queue: row.queue,
      }))
    ).toEqual([
      { canceled: 1, failed: 2, queue: 'embedding' },
      { canceled: 1, failed: 0, queue: 'maintenance' },
    ]);

    // Idempotent-by-guard: a re-run after rows were pruned must not shrink
    // or double-count the already-seeded totals.
    await db.query("DELETE FROM job_queue WHERE state IN ('failed', 'canceled')");
    const up = getMigration064().up;
    if (typeof up !== 'string') {
      throw new Error('Migration 061 up must be SQL');
    }
    for (const statement of up.split('--> statement-breakpoint')) {
      await db.query(statement);
    }
    const rerun = await db.query<{ failed_total: number | string }>(
      "SELECT failed_total FROM job_queue_metrics WHERE queue = 'embedding'"
    );
    expect(Number(rerun.rows[0]?.failed_total ?? -1)).toBe(2);
  });
});
