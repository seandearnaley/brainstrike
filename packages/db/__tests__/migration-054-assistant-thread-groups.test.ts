import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

interface CountRow {
  count: number | string;
}

describe('migration 054: assistant thread groups + placements tables', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-assistant-thread-groups');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 54));
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration054() {
    const migration = migrations.find((candidate) => candidate.version === 54);
    if (!migration) {
      throw new Error('Migration 054 is missing');
    }
    return migration;
  }

  it('creates the groups and placements tables', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration054());

    const tables = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_name IN (
         'brainstrike_assistant_thread_groups',
         'brainstrike_assistant_thread_placements'
       )`
    );
    expect(Number(tables.rows[0]?.count ?? 0)).toBe(2);
  });

  it('upserts a placement on conflicting thread_id', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration054());

    await db.query(
      `INSERT INTO brainstrike_assistant_thread_groups (id, resource_id, name, rank)
       VALUES ('group-1', 'workspace-a', 'Research', 'a0')`
    );
    await db.query(
      `INSERT INTO brainstrike_assistant_thread_placements (thread_id, resource_id, group_id, rank)
       VALUES ('thread-1', 'workspace-a', 'group-1', 'a0')`
    );
    await db.query(
      `INSERT INTO brainstrike_assistant_thread_placements (thread_id, resource_id, group_id, rank)
       VALUES ('thread-1', 'workspace-a', NULL, 'a1')
       ON CONFLICT (thread_id) DO UPDATE
         SET group_id = EXCLUDED.group_id,
             rank = EXCLUDED.rank,
             updated_at = NOW()`
    );

    const rows = await db.query<{ group_id: string | null; rank: string }>(
      `SELECT group_id, rank FROM brainstrike_assistant_thread_placements
       WHERE thread_id = 'thread-1'`
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.group_id).toBeNull();
    expect(rows.rows[0]?.rank).toBe('a1');
  });

  it('rollback drops both tables', { timeout: 60_000 }, async () => {
    const migration = getMigration054();
    await runner.runMigration(migration);
    await runner.rollback(migration);

    const tables = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_name IN (
         'brainstrike_assistant_thread_groups',
         'brainstrike_assistant_thread_placements'
       )`
    );
    expect(Number(tables.rows[0]?.count ?? -1)).toBe(0);
  });
});
