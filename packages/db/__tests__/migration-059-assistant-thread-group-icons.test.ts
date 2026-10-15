import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { createDbAtVersion } from './helpers/migrated-test-db.js';

describe('migration 059: assistant thread group icons', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await createDbAtVersion(58);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration059() {
    const migration = migrations.find((candidate) => candidate.version === 59);
    if (!migration) {
      throw new Error('Migration 059 is missing');
    }
    return migration;
  }

  it('adds a nullable validated icon without changing existing groups', async () => {
    await db.query(
      `INSERT INTO brainstrike_assistant_thread_groups (id, resource_id, name, rank, color)
       VALUES ('group-legacy', 'workspace-a', 'Legacy', 'a0', 'rose')`
    );

    await runner.runMigration(getMigration059());

    const columns = await db.query<{ column_name: string; is_nullable: 'NO' | 'YES' }>(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'brainstrike_assistant_thread_groups' AND column_name = 'icon'`
    );
    const legacy = await db.query<{ icon: string | null }>(
      `SELECT icon FROM brainstrike_assistant_thread_groups WHERE id = 'group-legacy'`
    );
    expect(columns.rows).toEqual([{ column_name: 'icon', is_nullable: 'YES' }]);
    expect(legacy.rows).toEqual([{ icon: null }]);

    await db.query(
      `UPDATE brainstrike_assistant_thread_groups SET icon = 'research' WHERE id = 'group-legacy'`
    );
    await expect(
      db.query(
        `UPDATE brainstrike_assistant_thread_groups SET icon = 'folder' WHERE id = 'group-legacy'`
      )
    ).rejects.toThrow();
  });

  it('rollback removes the icon column', async () => {
    const migration = getMigration059();
    await runner.runMigration(migration);
    await runner.rollback(migration);

    const columns = await db.query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.columns
       WHERE table_name = 'brainstrike_assistant_thread_groups' AND column_name = 'icon'`
    );
    expect(Number(columns.rows[0]?.count ?? -1)).toBe(0);
  });
});
