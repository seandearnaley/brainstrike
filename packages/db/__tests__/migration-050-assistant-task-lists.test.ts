import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { createDbAtVersion } from './helpers/migrated-test-db.js';

interface CountRow {
  count: number | string;
}

interface TaskListRow {
  resource_id: string;
  tasks: unknown;
}

describe('migration 050: assistant task lists table', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await createDbAtVersion(49);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration050() {
    const migration = migrations.find((candidate) => candidate.version === 50);
    if (!migration) {
      throw new Error('Migration 050 is missing');
    }
    return migration;
  }

  it('creates the task-lists table keyed by thread_id', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration050());

    const table = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_name = 'brainstrike_assistant_task_lists'`
    );
    expect(Number(table.rows[0]?.count ?? 0)).toBe(1);
  });

  it('whole-replaces the tasks on conflicting thread_id and bumps updated_at', {
    timeout: 60_000,
  }, async () => {
    await runner.runMigration(getMigration050());

    await db.query(
      `INSERT INTO brainstrike_assistant_task_lists (thread_id, resource_id, tasks, updated_at)
       VALUES ('thread-1', 'workspace-a',
         '[{"id":"a","content":"Read","activeForm":"Reading","status":"pending"}]'::jsonb,
         NOW() - INTERVAL '1 hour')`
    );

    const before = await db.query<{ updated_at: string }>(
      `SELECT updated_at FROM brainstrike_assistant_task_lists WHERE thread_id = 'thread-1'`
    );

    await db.query(
      `INSERT INTO brainstrike_assistant_task_lists (thread_id, resource_id, tasks)
       VALUES ('thread-1', 'workspace-a',
         '[{"id":"a","content":"Read","activeForm":"Reading","status":"completed"},
           {"id":"b","content":"Write","activeForm":"Writing","status":"in_progress"}]'::jsonb)
       ON CONFLICT (thread_id) DO UPDATE
         SET tasks = EXCLUDED.tasks,
             resource_id = EXCLUDED.resource_id,
             updated_at = NOW()`
    );

    const rows = await db.query<TaskListRow & { updated_at: string }>(
      `SELECT resource_id, tasks, updated_at
       FROM brainstrike_assistant_task_lists WHERE thread_id = 'thread-1'`
    );
    expect(rows.rows).toHaveLength(1);
    const tasks = rows.rows[0]?.tasks as Array<{ status: string }>;
    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => task.status)).toEqual(['completed', 'in_progress']);
    expect(Date.parse(rows.rows[0]?.updated_at ?? '')).toBeGreaterThan(
      Date.parse(before.rows[0]?.updated_at ?? '')
    );
  });

  it('rollback drops the table', { timeout: 60_000 }, async () => {
    const migration = getMigration050();
    await runner.runMigration(migration);
    await runner.rollback(migration);

    const table = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_name = 'brainstrike_assistant_task_lists'`
    );
    expect(Number(table.rows[0]?.count ?? -1)).toBe(0);
  });
});
