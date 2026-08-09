import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { getResetTables } from '../src/reset-table-registry.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

const TABLE = 'brainstrike_token_estimate_calibration';
const MODEL_INDEX = 'brainstrike_token_estimate_calibration_model_idx';
const OCCURRED_AT_INDEX = 'brainstrike_token_estimate_calibration_occurred_at_idx';

async function listIndexes(db: PGlite): Promise<string[]> {
  const result = await db.query<{ indexname: string }>(
    'SELECT indexname FROM pg_indexes WHERE tablename = $1',
    [TABLE]
  );
  return result.rows.map((row) => row.indexname);
}

describe('migration 086: token-estimate calibration (BST-1205)', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('pglite-test-token-calibration'));
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 86));
  });

  afterEach(async () => db.close());

  it('creates the FK-less calibration table and both query/retention indexes', async () => {
    const migration = migrations.find((candidate) => candidate.version === 86);
    expect(migration).toBeDefined();
    await runner.runMigration(migration!);

    await db.query(
      `INSERT INTO ${TABLE}
        (id, thread_id, run_id, model, provider, estimated_prompt_tokens,
         provider_reported_prompt_tokens, occurred_at)
       VALUES ('id-1', 'thread-1', 'run-1', 'gpt-5.6-terra', 'openai', 42, 50, NOW())`
    );
    expect((await db.query(`SELECT * FROM ${TABLE}`)).rows).toHaveLength(1);
    expect(await listIndexes(db)).toEqual(expect.arrayContaining([MODEL_INDEX, OCCURRED_AT_INDEX]));
    expect(getResetTables()).toContain(TABLE);
  });

  it('rejects negative estimated or provider-reported prompt counts', async () => {
    await runner.runMigration(migrations.find((candidate) => candidate.version === 86)!);
    await expect(
      db.query(
        `INSERT INTO ${TABLE}
          (id, thread_id, run_id, model, provider, estimated_prompt_tokens,
           provider_reported_prompt_tokens)
         VALUES ('bad-estimate', 'thread', 'run', 'model', 'provider', -1, 1)`
      )
    ).rejects.toThrow(/check constraint/i);
    await expect(
      db.query(
        `INSERT INTO ${TABLE}
          (id, thread_id, run_id, model, provider, estimated_prompt_tokens,
           provider_reported_prompt_tokens)
         VALUES ('bad-provider', 'thread', 'run', 'model', 'provider', 1, -1)`
      )
    ).rejects.toThrow(/check constraint/i);
  });
});

describe('migration 086 in the drizzle runner', () => {
  let db: PGlite;
  beforeEach(() => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector } });
  });
  afterEach(async () => db.close());

  it('creates the same table and indexes in the production runner', {
    timeout: 60_000,
  }, async () => {
    expect((await runMigrations(db)).success).toBe(true);
    expect(await listIndexes(db)).toEqual(expect.arrayContaining([MODEL_INDEX, OCCURRED_AT_INDEX]));
  });
});
