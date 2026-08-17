import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

describe('migration 089: token-estimate calibration resolved budgets (BST-1219)', () => {
  const table = 'brainstrike_token_estimate_calibration';
  let db: Awaited<ReturnType<typeof wasmLoader.createPGlite>>;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('migration-089-calibration'));
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 89));
  });

  afterEach(async () => db.close());

  it('adds nullable positive integer budget columns and rolls them back cleanly', async () => {
    const migration = migrations.find((candidate) => candidate.version === 89);
    expect(migration).toBeDefined();
    await runner.runMigration(migration!);

    const columns = await db.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_name = $1
         AND column_name LIKE 'resolved_%_budget_tokens'
       ORDER BY column_name`,
      [table]
    );
    expect(columns.rows).toEqual([
      {
        column_name: 'resolved_domain_budget_tokens',
        data_type: 'integer',
        is_nullable: 'YES',
      },
      {
        column_name: 'resolved_transport_budget_tokens',
        data_type: 'integer',
        is_nullable: 'YES',
      },
    ]);

    await expect(
      db.query(
        `INSERT INTO ${table}
          (id, thread_id, run_id, model, provider, estimated_prompt_tokens,
           final_step_prompt_tokens, resolved_domain_budget_tokens)
         VALUES ('bad', 'thread', 'run', 'model', 'provider', 1, 1, 0)`
      )
    ).rejects.toThrow(/check constraint/i);

    await runner.rollback(migration!);
    const afterRollback = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = $1 AND column_name LIKE 'resolved_%_budget_tokens'`,
      [table]
    );
    expect(afterRollback.rows).toEqual([]);
  });
});

describe('migration 089 in the drizzle runner', () => {
  it('adds both resolved-budget columns in the production migration ledger', async () => {
    const db = new PGlite({
      extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector },
    });
    try {
      expect((await runMigrations(db)).success).toBe(true);
      const columns = await db.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_name = 'brainstrike_token_estimate_calibration'
           AND column_name LIKE 'resolved_%_budget_tokens'
         ORDER BY column_name`
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'resolved_domain_budget_tokens',
        'resolved_transport_budget_tokens',
      ]);
    } finally {
      await db.close();
    }
  });
});
