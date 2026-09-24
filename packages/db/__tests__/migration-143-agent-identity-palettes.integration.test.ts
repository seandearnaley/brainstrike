import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { createDelegatedConversationRepository } from '../src/repositories/delegated-conversation-repository.js';
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
    const repository = createDelegatedConversationRepository(db);
    const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };
    await repository.registerRoot(scope);
    await repository.createChild(scope, {
      color: 'rose',
      configuration: {},
      displayName: 'Old',
      parentThreadId: 'root',
      resourceId: 'old-resource',
      threadId: 'old-child',
    });

    const migration = migrations.find((candidate) => candidate.version === 143);
    if (!migration) {
      throw new Error('Migration 143 is missing');
    }
    await runner.runMigration(migration);
    await db.exec(`INSERT INTO brainstrike_assistant_thread_groups
      (id, resource_id, name, rank, color)
      VALUES ('new-group', 'owner', 'New', 'a1', 'cyan');`);
    await repository.createChild(scope, {
      color: 'lime',
      configuration: {},
      displayName: 'New',
      parentThreadId: 'root',
      resourceId: 'new-resource',
      threadId: 'new-child',
    });

    expect(
      (
        await db.query<{ color: string }>(
          'SELECT color FROM brainstrike_assistant_thread_groups ORDER BY id'
        )
      ).rows
    ).toEqual([{ color: 'cyan' }, { color: 'rose' }]);
    expect(await repository.get(scope, 'new-child')).toMatchObject({ color: 'lime' });
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
  });
});
