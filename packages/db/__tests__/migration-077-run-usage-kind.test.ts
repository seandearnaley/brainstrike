import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { createDbAtVersion } from './helpers/migrated-test-db.js';

interface ColumnRow {
  column_default: string | null;
  column_name: string;
  is_nullable: 'NO' | 'YES';
}

describe('migration 077: run-usage run_kind attribution', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await createDbAtVersion(76);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration077() {
    const migration = migrations.find((candidate) => candidate.version === 77);
    if (!migration) {
      throw new Error('Migration 077 is missing');
    }
    return migration;
  }

  async function insertUsageRow(id: string, runKindSql: string): Promise<void> {
    await db.query(
      `INSERT INTO brainstrike_assistant_run_usage
        (id, thread_id, run_id, resource_id, model, provider, input_tokens, output_tokens, created_at${runKindSql ? ', run_kind' : ''})
       VALUES ('${id}', 'thread-1', 'run-1', 'workspace-a', 'claude-sonnet-5', 'anthropic', 100, 10, NOW()${runKindSql ? `, ${runKindSql}` : ''})`
    );
  }

  it('adds a NOT NULL run_kind column defaulting existing and new rows to chat', async () => {
    // A pre-migration row must be backfilled by the DEFAULT, not left NULL.
    await insertUsageRow('row-pre', '');

    await runner.runMigration(getMigration077());

    const columns = await db.query<ColumnRow>(
      `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'brainstrike_assistant_run_usage'
         AND column_name = 'run_kind'`
    );
    expect(columns.rows).toHaveLength(1);
    expect(columns.rows[0]?.is_nullable).toBe('NO');
    expect(columns.rows[0]?.column_default).toContain('chat');

    await insertUsageRow('row-post', '');
    const kinds = await db.query<{ id: string; run_kind: string }>(
      'SELECT id, run_kind FROM brainstrike_assistant_run_usage ORDER BY id'
    );
    expect(kinds.rows).toEqual([
      { id: 'row-post', run_kind: 'chat' },
      { id: 'row-pre', run_kind: 'chat' },
    ]);
  });

  it('accepts every attribution kind and rejects unknown kinds (no silent fallback)', async () => {
    await runner.runMigration(getMigration077());

    await insertUsageRow('row-subagent', `'subagent'`);
    await insertUsageRow('row-om-obs', `'om-observation'`);
    await insertUsageRow('row-om-refl', `'om-reflection'`);

    await expect(insertUsageRow('row-bogus', `'embedding'`)).rejects.toThrow(/check|constraint/i);
  });
});
