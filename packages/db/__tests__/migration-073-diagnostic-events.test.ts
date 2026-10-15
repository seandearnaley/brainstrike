import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { createDbAtVersion } from './helpers/migrated-test-db.js';

describe('migration 073: diagnostic events', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await createDbAtVersion(72);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration073() {
    const migration = migrations.find((candidate) => candidate.version === 73);
    if (!migration) {
      throw new Error('Migration 073 is missing');
    }
    return migration;
  }

  it('creates the table with severity check and lifecycle indexes', async () => {
    await runner.runMigration(getMigration073());

    const table = await db.query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_name = 'brainstrike_diagnostic_events'`
    );
    expect(Number(table.rows[0]?.count ?? 0)).toBe(1);

    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'brainstrike_diagnostic_events'`
    );
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).toContain('bst_diagnostic_events_occurred_idx');
    expect(names).toContain('bst_diagnostic_events_fingerprint_idx');
    expect(names).toContain('bst_diagnostic_events_thread_idx');
    expect(names).toContain('bst_diagnostic_events_severity_idx');

    await expect(
      db.query(
        `INSERT INTO brainstrike_diagnostic_events
           (id, occurred_at, severity, source, message, fingerprint, session_id, app_version, platform)
         VALUES ('e1', NOW(), 'info', 'web-renderer', 'm', 'f', 's', 'v', 'p')`
      )
    ).rejects.toThrow(); // severity check: warn|error|fatal only
  });

  it('round-trips down/up idempotently', async () => {
    const migration = getMigration073();
    await runner.runMigration(migration);
    await runner.rollback(migration);
    await runner.runMigration(migration);
    const table = await db.query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_name = 'brainstrike_diagnostic_events'`
    );
    expect(Number(table.rows[0]?.count ?? 0)).toBe(1);
  });
});
