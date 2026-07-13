import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

interface ColumnRow {
  column_name: string;
  is_nullable: 'NO' | 'YES';
}

describe('migration 056: assistant thread group presentation', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-assistant-thread-group-presentation');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 56));
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration056() {
    const migration = migrations.find((candidate) => candidate.version === 56);
    if (!migration) {
      throw new Error('Migration 056 is missing');
    }
    return migration;
  }

  it('adds nullable validated group color and nullable flat placement rank', async () => {
    await runner.runMigration(getMigration056());

    const groupColumns = await db.query<ColumnRow>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'brainstrike_assistant_thread_groups'
         AND column_name = 'color'`
    );
    const placementColumns = await db.query<ColumnRow>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'brainstrike_assistant_thread_placements'
         AND column_name = 'flat_rank'`
    );

    expect(groupColumns.rows).toEqual([{ column_name: 'color', is_nullable: 'YES' }]);
    expect(placementColumns.rows).toEqual([{ column_name: 'flat_rank', is_nullable: 'YES' }]);

    await db.query(
      `INSERT INTO brainstrike_assistant_thread_groups
         (id, resource_id, name, rank, color)
       VALUES ('group-valid', 'workspace-a', 'Valid', 'a0', 'rose')`
    );
    await expect(
      db.query(
        `INSERT INTO brainstrike_assistant_thread_groups
           (id, resource_id, name, rank, color)
         VALUES ('group-invalid', 'workspace-a', 'Invalid', 'a1', 'magenta')`
      )
    ).rejects.toThrow();
  });

  it('preserves existing groups and seeds flat order from the legacy placement rank', async () => {
    await db.query(
      `INSERT INTO brainstrike_assistant_thread_groups (id, resource_id, name, rank)
       VALUES ('group-legacy', 'workspace-a', 'Legacy', 'a0')`
    );
    await db.query(
      `INSERT INTO brainstrike_assistant_thread_placements
         (thread_id, resource_id, group_id, rank)
       VALUES ('thread-legacy', 'workspace-a', 'group-legacy', 'a0')`
    );

    await runner.runMigration(getMigration056());

    const groups = await db.query<{ color: string | null; id: string }>(
      `SELECT id, color FROM brainstrike_assistant_thread_groups WHERE id = 'group-legacy'`
    );
    const placements = await db.query<{ flat_rank: string | null; thread_id: string }>(
      `SELECT thread_id, flat_rank
       FROM brainstrike_assistant_thread_placements
       WHERE thread_id = 'thread-legacy'`
    );
    expect(groups.rows).toEqual([{ color: null, id: 'group-legacy' }]);
    expect(placements.rows).toEqual([{ flat_rank: 'a0', thread_id: 'thread-legacy' }]);
  });

  it('rollback removes both presentation columns', async () => {
    const migration = getMigration056();
    await runner.runMigration(migration);
    await runner.rollback(migration);

    const columns = await db.query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.columns
       WHERE (table_name = 'brainstrike_assistant_thread_groups' AND column_name = 'color')
          OR (table_name = 'brainstrike_assistant_thread_placements' AND column_name = 'flat_rank')`
    );
    expect(Number(columns.rows[0]?.count ?? -1)).toBe(0);
  });
});
