import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { createDbAtVersion } from './helpers/migrated-test-db.js';

describe('migration 076: assistant run errors', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await createDbAtVersion(75);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration076() {
    const migration = migrations.find((candidate) => candidate.version === 76);
    if (!migration) {
      throw new Error('Migration 076 is missing');
    }
    return migration;
  }

  it('creates the FK-less table, lifecycle indexes, and diagnostic run index', async () => {
    await runner.runMigration(getMigration076());

    const table = await db.query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.tables
       WHERE table_name = 'brainstrike_assistant_run_errors'`
    );
    expect(Number(table.rows[0]?.count ?? 0)).toBe(1);

    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = 'brainstrike_assistant_run_errors'
       ORDER BY ordinal_position`
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'run_id',
      'thread_id',
      'resource_id',
      'code',
      'message',
      'cause_chain',
      'http_status',
      'provider_request_id',
      'response_headers',
      'occurred_at',
      'created_at',
    ]);
    expect(columns.rows.map((row) => row.column_name)).not.toContain('attempts');

    const runErrorIndexes = await db.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE tablename = 'brainstrike_assistant_run_errors'`
    );
    const names = runErrorIndexes.rows.map((row) => row.indexname);
    expect(names).toContain('brainstrike_assistant_run_errors_pkey');
    expect(names).toContain('bst_assistant_run_errors_thread_idx');
    expect(names).toContain('bst_assistant_run_errors_resource_idx');

    const diagnosticIndexes = await db.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE tablename = 'brainstrike_diagnostic_events'`
    );
    expect(diagnosticIndexes.rows.map((row) => row.indexname)).toContain(
      'bst_diagnostic_events_run_idx'
    );
  });

  it('enforces honest JSON shapes, HTTP status, and required identifiers', async () => {
    await runner.runMigration(getMigration076());

    const insert = (overrides: {
      causeChain?: string;
      code?: string;
      httpStatus?: number;
      responseHeaders?: string;
      runId?: string;
    }) =>
      db.query(
        `INSERT INTO brainstrike_assistant_run_errors (
           run_id, thread_id, resource_id, code, cause_chain, http_status,
           response_headers, occurred_at
         ) VALUES ($1, 'thread-a', 'resource-a', $2, $3::jsonb, $4, $5::jsonb, NOW())`,
        [
          overrides.runId ?? 'run-a',
          overrides.code ?? 'provider_error',
          overrides.causeChain ?? '[]',
          overrides.httpStatus ?? 500,
          overrides.responseHeaders ?? '{}',
        ]
      );

    await expect(insert({ causeChain: '{}' })).rejects.toThrow();
    await expect(insert({ responseHeaders: '[]' })).rejects.toThrow();
    await expect(insert({ httpStatus: 99 })).rejects.toThrow();
    await expect(insert({ code: '' })).rejects.toThrow();
    await expect(insert({ runId: '' })).rejects.toThrow();
  });

  it('round-trips down/up idempotently', async () => {
    const migration = getMigration076();
    await runner.runMigration(migration);
    await runner.rollback(migration);
    await runner.runMigration(migration);

    const table = await db.query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.tables
       WHERE table_name = 'brainstrike_assistant_run_errors'`
    );
    expect(Number(table.rows[0]?.count ?? 0)).toBe(1);
  });
});
