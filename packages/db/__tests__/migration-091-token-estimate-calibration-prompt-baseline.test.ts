import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

const TABLE = 'brainstrike_token_estimate_calibration';

describe('migration 091: token-estimate calibration prompt baseline (BST-1232)', () => {
  let db: Awaited<ReturnType<typeof wasmLoader.createPGlite>>;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('migration-091-calibration'));
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 91));
  });

  afterEach(async () => db.close());

  it('adds a nullable positive prompt baseline and rolls it back cleanly', async () => {
    const migration = migrations.find((candidate) => candidate.version === 91);
    expect(migration).toBeDefined();
    await runner.runMigration(migration!);

    const columns = await db.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_name = $1 AND column_name = 'prompt_baseline_tokens'`,
      [TABLE]
    );
    expect(columns.rows).toEqual([
      { column_name: 'prompt_baseline_tokens', data_type: 'integer', is_nullable: 'YES' },
    ]);

    await expect(
      db.query(
        `INSERT INTO ${TABLE}
          (id, thread_id, run_id, model, provider, estimated_prompt_tokens,
           final_step_prompt_tokens, prompt_baseline_tokens)
         VALUES ('bad', 'thread', 'run', 'model', 'provider', 1, 1, 0)`
      )
    ).rejects.toThrow(/check constraint/i);

    await runner.rollback(migration!);
    const afterRollback = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = $1 AND column_name = 'prompt_baseline_tokens'`,
      [TABLE]
    );
    expect(afterRollback.rows).toEqual([]);
  });
});

describe('migration 091 in the drizzle runner', () => {
  it('adds the prompt baseline column in the production migration ledger', async () => {
    const db = new PGlite({
      extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector },
    });
    try {
      expect((await runMigrations(db)).success).toBe(true);
      const columns = await db.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_name = '${TABLE}' AND column_name = 'prompt_baseline_tokens'`
      );
      expect(columns.rows).toEqual([{ column_name: 'prompt_baseline_tokens' }]);
    } finally {
      await db.close();
    }
  });
});
