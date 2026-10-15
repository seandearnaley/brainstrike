import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { createDbAtVersion } from './helpers/migrated-test-db.js';

interface CountRow {
  count: number | string;
}

interface IndexRow {
  indexname: string;
}

const TABLE = 'brainstrike_assistant_edit_checkpoints';

describe('migration 052: assistant edit checkpoints table', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await createDbAtVersion(51);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration052() {
    const migration = migrations.find((candidate) => candidate.version === 52);
    if (!migration) {
      throw new Error('Migration 052 is missing');
    }
    return migration;
  }

  async function insertRow(overrides: Record<string, string>): Promise<void> {
    const base: Record<string, string> = {
      after_existed: 'true',
      before_existed: 'false',
      capture_status: 'created',
      created_at: 'NOW()',
      id: 'c1',
      occurred_at: 'NOW()',
      op: 'write',
      path: '/a.txt',
      resource_id: 'workspace-a',
      root_id: 'root-1',
      run_id: 'run-1',
      thread_id: 'thread-1',
      tool_name: 'brainstrike.writeWorkspaceFile',
      updated_at: 'NOW()',
    };
    const merged = { ...base, ...overrides };
    const columns = Object.keys(merged);
    const values = columns.map((col) => {
      const raw = merged[col];
      if (raw === 'NOW()' || raw === 'true' || raw === 'false' || raw === 'NULL') {
        return raw;
      }
      return `'${raw.replaceAll("'", "''")}'`;
    });
    await db.query(`INSERT INTO ${TABLE} (${columns.join(', ')}) VALUES (${values.join(', ')})`);
  }

  it('creates the table and its three indexes', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration052());

    const table = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_name = '${TABLE}'`
    );
    expect(Number(table.rows[0]?.count ?? 0)).toBe(1);

    const indexes = await db.query<IndexRow>(
      `SELECT indexname FROM pg_indexes WHERE tablename = '${TABLE}'`
    );
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).toContain('brainstrike_assistant_edit_checkpoints_thread_idx');
    expect(names).toContain('brainstrike_assistant_edit_checkpoints_run_idx');
    expect(names).toContain('brainstrike_assistant_edit_checkpoints_revert_idx');
  });

  it('accepts every valid op and capture_status', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration052());

    const ops = ['write', 'string_replace', 'delete', 'rename'];
    const statuses = ['ok', 'created', 'skipped_binary', 'skipped_too_large', 'expired', 'rename'];
    let counter = 0;
    for (const op of ops) {
      for (const status of statuses) {
        counter += 1;
        await insertRow({ capture_status: status, id: `c-${counter}`, op });
      }
    }
    const count = await db.query<CountRow>(`SELECT COUNT(*)::int AS count FROM ${TABLE}`);
    expect(Number(count.rows[0]?.count ?? 0)).toBe(ops.length * statuses.length);
  });

  it('rejects an invalid op via the CHECK constraint', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration052());
    await expect(insertRow({ id: 'bad-op', op: 'chmod' })).rejects.toThrow();
  });

  it('rejects an invalid capture_status via the CHECK constraint', {
    timeout: 60_000,
  }, async () => {
    await runner.runMigration(getMigration052());
    await expect(insertRow({ capture_status: 'garbage', id: 'bad-status' })).rejects.toThrow();
  });

  it('rollback drops the table', { timeout: 60_000 }, async () => {
    const migration = getMigration052();
    await runner.runMigration(migration);
    await runner.rollback(migration);

    const table = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_name = '${TABLE}'`
    );
    expect(Number(table.rows[0]?.count ?? -1)).toBe(0);
  });
});
