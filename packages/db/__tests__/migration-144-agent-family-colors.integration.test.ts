import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir.js';

describe('migration 144 agent family colors', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('migration-144'));
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 144));
  });

  afterEach(async () => {
    await db.close();
  });

  it('preserves legacy colors and admits only canonical bounded family tokens', async () => {
    await db.exec(`INSERT INTO mastra_threads (id, "resourceId", title, metadata, "createdAt", "updatedAt")
      VALUES ('root', 'owner', 'Root', '{}', now(), now()),
             ('legacy', 'legacy-owner', 'Legacy', '{}', now(), now()),
             ('family', 'family-owner', 'Family', '{}', now(), now());`);
    await db.exec(`INSERT INTO brainstrike_delegated_conversations
      (thread_id, owner_resource_id, root_thread_id, resource_id, configuration)
      VALUES ('root', 'owner', 'root', 'owner', NULL)`);
    await db.exec(`INSERT INTO brainstrike_delegated_conversations
      (thread_id, owner_resource_id, root_thread_id, parent_thread_id, resource_id, configuration, display_name, color)
      VALUES ('legacy', 'owner', 'root', 'root', 'legacy-owner', '{}', 'Legacy', 'rose')`);
    const migration = migrations.find((candidate) => candidate.version === 144);
    if (!migration) {
      throw new Error('Migration 144 is missing.');
    }
    await runner.runMigration(migration);
    await db.exec(`INSERT INTO brainstrike_delegated_conversations
      (thread_id, owner_resource_id, root_thread_id, parent_thread_id, resource_id, configuration, display_name, color)
      VALUES ('family', 'owner', 'root', 'root', 'family-owner', '{}', 'Family', 'family:3599:999')`);
    expect(
      (
        await db.query(
          "SELECT color FROM brainstrike_delegated_conversations WHERE thread_id = 'legacy'"
        )
      ).rows
    ).toEqual([{ color: 'rose' }]);
    expect(
      (
        await db.query(
          "SELECT color FROM brainstrike_delegated_conversations WHERE thread_id = 'family'"
        )
      ).rows
    ).toEqual([{ color: 'family:3599:999' }]);
    for (const invalid of ['family:3600:500', 'family:0001:500', 'family:42:1000', 'magenta']) {
      await expect(
        db.query('UPDATE brainstrike_delegated_conversations SET color = $1 WHERE thread_id = $2', [
          invalid,
          'family',
        ])
      ).rejects.toThrow(/check constraint/i);
    }
    await expect(runner.rollback(migration)).rejects.toThrow(/check constraint/i);
  });
});
