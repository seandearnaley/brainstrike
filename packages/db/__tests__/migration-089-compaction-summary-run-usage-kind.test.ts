import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';

describe('migration 089: compaction-summary run usage kind', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = new PGlite();
    runner = new MigrationRunner(db);
    await runner.initialize();
    for (const version of [46, 77]) {
      await runner.runMigration(migrations.find((migration) => migration.version === version)!);
    }
  });

  afterEach(async () => db.close());

  it('accepts compaction-summary and keeps unknown kinds rejected', async () => {
    const migration = migrations.find((candidate) => candidate.version === 89);
    expect(migration).toBeDefined();
    await runner.runMigration(migration!);

    await expect(
      db.query(
        `INSERT INTO brainstrike_assistant_run_usage
          (id, thread_id, run_id, resource_id, model, provider, input_tokens, output_tokens, run_kind)
         VALUES ('usage-1', 'thread-1', 'run-1', 'resource-1', 'gpt-5.2', 'openai', 10, 2, 'compaction-summary')`
      )
    ).resolves.toBeDefined();
    await expect(
      db.query(
        `INSERT INTO brainstrike_assistant_run_usage
          (id, thread_id, run_id, resource_id, model, provider, input_tokens, output_tokens, run_kind)
         VALUES ('usage-2', 'thread-1', 'run-1', 'resource-1', 'gpt-5.2', 'openai', 10, 2, 'unknown')`
      )
    ).rejects.toThrow(/check constraint/i);
  });
});

describe('migration 089 in the drizzle runner', () => {
  let db: PGlite;

  beforeEach(() => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector } });
  });

  afterEach(async () => db.close());

  it('accepts compaction-summary in the production migration path', {
    timeout: 60_000,
  }, async () => {
    expect((await runMigrations(db)).success).toBe(true);
    await expect(
      db.query(
        `INSERT INTO brainstrike_assistant_run_usage
          (id, thread_id, run_id, resource_id, model, provider, input_tokens, output_tokens, run_kind)
         VALUES ('usage-drizzle', 'thread-1', 'run-1', 'resource-1', 'gpt-5.2', 'openai', 10, 2, 'compaction-summary')`
      )
    ).resolves.toBeDefined();
  });
});
