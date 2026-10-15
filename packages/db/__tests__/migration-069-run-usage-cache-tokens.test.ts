import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { createDbAtVersion } from './helpers/migrated-test-db.js';

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

describe('migration 069: run-usage cache token columns', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await createDbAtVersion(68);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration069() {
    const migration = migrations.find((candidate) => candidate.version === 69);
    if (!migration) {
      throw new Error('Migration 069 is missing');
    }
    return migration;
  }

  it('adds nullable non-negative cache token columns', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration069());

    const columns = await db.query<ColumnRow>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'brainstrike_assistant_run_usage'
         AND column_name IN ('cache_read_input_tokens', 'cache_creation_input_tokens')
       ORDER BY column_name`
    );
    expect(columns.rows).toEqual([
      {
        column_name: 'cache_creation_input_tokens',
        data_type: 'integer',
        is_nullable: 'YES',
      },
      {
        column_name: 'cache_read_input_tokens',
        data_type: 'integer',
        is_nullable: 'YES',
      },
    ]);

    await expect(
      db.query(
        `INSERT INTO brainstrike_assistant_run_usage
           (id, thread_id, run_id, resource_id, model, provider, input_tokens, output_tokens, cache_read_input_tokens)
         VALUES ('neg-1', 't', 'r', 'res', 'm', 'anthropic', 10, 5, -1)`
      )
    ).rejects.toThrow(/check/i);
  });

  it('is idempotent and reversible', { timeout: 60_000 }, async () => {
    const migration = getMigration069();
    await runner.runMigration(migration);
    // Re-running the up SQL directly must be a no-op (IF NOT EXISTS guards).
    await db.exec(migration.up);
    await db.exec(migration.down);

    const columns = await db.query<ColumnRow>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'brainstrike_assistant_run_usage'
         AND column_name IN ('cache_read_input_tokens', 'cache_creation_input_tokens')`
    );
    expect(columns.rows).toEqual([]);
  });
});
