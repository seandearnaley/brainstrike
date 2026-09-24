import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { createDelegatedConversationRepository } from '../src/repositories/delegated-conversation-repository.js';
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
    const repository = createDelegatedConversationRepository(db);
    const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };
    await repository.registerRoot(scope);
    await repository.createChild(scope, {
      color: 'rose',
      configuration: {},
      displayName: 'Legacy',
      parentThreadId: 'root',
      resourceId: 'legacy-owner',
      threadId: 'legacy',
    });
    const migration = migrations.find((candidate) => candidate.version === 144);
    if (!migration) {
      throw new Error('Migration 144 is missing.');
    }
    await runner.runMigration(migration);
    await repository.createChild(scope, {
      color: 'family:3599:999',
      configuration: {},
      displayName: 'Family',
      parentThreadId: 'root',
      resourceId: 'family-owner',
      threadId: 'family',
    });
    expect((await repository.get(scope, 'legacy'))?.color).toBe('rose');
    expect((await repository.get(scope, 'family'))?.color).toBe('family:3599:999');
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
