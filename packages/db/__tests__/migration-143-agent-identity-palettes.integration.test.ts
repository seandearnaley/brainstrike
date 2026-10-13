import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir.js';

describe('migration 143 agent identity palettes', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('migration-143'));
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 143));
  });

  afterEach(async () => {
    await db.close();
  });

  it('preserves old identities, accepts new colors, and still rejects unsupported ones', async () => {
    await db.exec(`INSERT INTO brainstrike_assistant_thread_groups
      (id, resource_id, name, rank, color)
      VALUES ('old-group', 'owner', 'Old', 'a0', 'rose');
      INSERT INTO mastra_threads (id, "resourceId", title, metadata, "createdAt", "updatedAt")
      VALUES ('root', 'owner', 'Root', '{}', now(), now()),
             ('old-child', 'old-resource', 'Old child', '{}', now(), now()),
             ('new-child', 'new-resource', 'New child', '{}', now(), now());`);
    await db.exec(`INSERT INTO brainstrike_delegated_conversations
      (thread_id, owner_resource_id, root_thread_id, resource_id, configuration)
      VALUES ('root', 'owner', 'root', 'owner', NULL)`);
    await db.exec(`INSERT INTO brainstrike_delegated_conversations
      (thread_id, owner_resource_id, root_thread_id, parent_thread_id, resource_id, configuration, display_name, color)
      VALUES ('old-child', 'owner', 'root', 'root', 'old-resource', '{}', 'Old', 'rose')`);

    const migration = migrations.find((candidate) => candidate.version === 143);
    if (!migration) {
      throw new Error('Migration 143 is missing');
    }
    await runner.runMigration(migration);
    await db.exec(`INSERT INTO brainstrike_assistant_thread_groups
      (id, resource_id, name, rank, color)
      VALUES ('new-group', 'owner', 'New', 'a1', 'cyan');`);
    await db.exec(`INSERT INTO brainstrike_delegated_conversations
      (thread_id, owner_resource_id, root_thread_id, parent_thread_id, resource_id, configuration, display_name, color)
      VALUES ('new-child', 'owner', 'root', 'root', 'new-resource', '{}', 'New', 'lime')`);

    expect(
      (
        await db.query<{ color: string }>(
          'SELECT color FROM brainstrike_assistant_thread_groups ORDER BY id'
        )
      ).rows
    ).toEqual([{ color: 'cyan' }, { color: 'rose' }]);
    expect(
      (
        await db.query(
          "SELECT color FROM brainstrike_delegated_conversations WHERE thread_id = 'new-child'"
        )
      ).rows
    ).toEqual([{ color: 'lime' }]);
    await expect(
      db.exec(
        `UPDATE brainstrike_assistant_thread_groups SET color = 'magenta' WHERE id = 'new-group'`
      )
    ).rejects.toThrow(/check constraint/i);
    await expect(
      db.exec(
        `UPDATE brainstrike_delegated_conversations SET color = 'magenta' WHERE thread_id = 'new-child'`
      )
    ).rejects.toThrow(/check constraint/i);

    await expect(runner.rollback(migration)).rejects.toThrow(/check constraint/i);
    await db.exec(`UPDATE brainstrike_assistant_thread_groups SET color = 'rose' WHERE id = 'new-group';
      UPDATE brainstrike_delegated_conversations SET color = 'rose' WHERE thread_id = 'new-child';`);
    await runner.rollback(migration);
    await expect(
      db.exec(`UPDATE brainstrike_assistant_thread_groups SET color = 'red' WHERE id = 'new-group'`)
    ).rejects.toThrow(/check constraint/i);
  });
});
