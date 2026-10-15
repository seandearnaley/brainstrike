import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { createDbAtVersion } from './helpers/migrated-test-db.js';

interface CountRow {
  count: number | string;
}

describe('migration 095: per-thread workspace snapshots table', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await createDbAtVersion(94);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration095() {
    const migration = migrations.find((candidate) => candidate.version === 95);
    if (!migration) {
      throw new Error('Migration 095 is missing');
    }
    return migration;
  }

  it('creates the thread workspaces table', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration095());

    const tables = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_name = 'brainstrike_assistant_thread_workspaces'`
    );
    expect(Number(tables.rows[0]?.count ?? 0)).toBe(1);
  });

  it('upserts a workspace snapshot on conflicting thread_id', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration095());

    await db.query(
      `INSERT INTO brainstrike_assistant_thread_workspaces (thread_id, resource_id, payload)
       VALUES ('thread-1', 'brainstrike:workspace', '{"version":1}'::jsonb)`
    );
    await db.query(
      `INSERT INTO brainstrike_assistant_thread_workspaces (thread_id, resource_id, payload)
       VALUES ('thread-1', 'brainstrike:workspace', '{"version":1,"apps":{}}'::jsonb)
       ON CONFLICT (thread_id) DO UPDATE
         SET payload = EXCLUDED.payload,
             updated_at = NOW()`
    );

    const rows = await db.query<{ payload: { apps?: unknown } }>(
      `SELECT payload FROM brainstrike_assistant_thread_workspaces WHERE thread_id = 'thread-1'`
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.payload).toEqual({ apps: {}, version: 1 });
  });

  it('rejects a NULL payload (workspace rows are never sparse)', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration095());

    await expect(
      db.query(
        `INSERT INTO brainstrike_assistant_thread_workspaces (thread_id, resource_id, payload)
         VALUES ('thread-2', 'brainstrike:workspace', NULL)`
      )
    ).rejects.toThrow(/null value/i);
  });
});
