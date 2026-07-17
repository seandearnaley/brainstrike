import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

interface CountRow {
  count: number | string;
}

interface IndexRow {
  indexname: string;
}

describe('migration 062: assistant run outcomes table', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-assistant-run-outcomes');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 62));
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration062() {
    const migration = migrations.find((candidate) => candidate.version === 62);
    if (!migration) {
      throw new Error('Migration 062 is missing');
    }
    return migration;
  }

  it('creates the run-outcomes table and indexes', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration062());

    const table = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_name = 'brainstrike_assistant_run_outcomes'`
    );
    expect(Number(table.rows[0]?.count ?? 0)).toBe(1);

    const index = await db.query<IndexRow>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'brainstrike_assistant_run_outcomes'`
    );
    const names = index.rows.map((row) => row.indexname);
    expect(names).toContain('brainstrike_assistant_run_outcomes_thread_idx');
    expect(names).toContain('brainstrike_assistant_run_outcomes_resource_idx');
  });

  it('holds exactly one label per run with upsert semantics', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration062());

    await db.query(
      `INSERT INTO brainstrike_assistant_run_outcomes
        (run_id, thread_id, resource_id, verdict, source, detail, labeled_at)
       VALUES ('run-1', 'thread-1', 'workspace-a', 'succeeded', 'user', NULL, NOW())`
    );
    await db.query(
      `INSERT INTO brainstrike_assistant_run_outcomes
        (run_id, thread_id, resource_id, verdict, source, detail, labeled_at)
       VALUES ('run-1', 'thread-1', 'workspace-a', 'failed', 'edit_revert', 'all edits reverted', NOW())
       ON CONFLICT (run_id) DO UPDATE SET
        verdict = EXCLUDED.verdict,
        source = EXCLUDED.source,
        detail = EXCLUDED.detail,
        labeled_at = EXCLUDED.labeled_at,
        updated_at = NOW()`
    );

    const rows = await db.query<{ verdict: string; source: string; detail: string | null }>(
      `SELECT verdict, source, detail FROM brainstrike_assistant_run_outcomes WHERE run_id = 'run-1'`
    );
    expect(rows.rows).toEqual([
      { detail: 'all edits reverted', source: 'edit_revert', verdict: 'failed' },
    ]);
  });

  it('rejects unknown verdicts and sources via CHECK constraints', {
    timeout: 60_000,
  }, async () => {
    await runner.runMigration(getMigration062());

    await expect(
      db.query(
        `INSERT INTO brainstrike_assistant_run_outcomes
          (run_id, thread_id, resource_id, verdict, source, labeled_at)
         VALUES ('run-bad', 'thread-1', 'workspace-a', 'sort-of-worked', 'user', NOW())`
      )
    ).rejects.toThrow();

    await expect(
      db.query(
        `INSERT INTO brainstrike_assistant_run_outcomes
          (run_id, thread_id, resource_id, verdict, source, labeled_at)
         VALUES ('run-bad', 'thread-1', 'workspace-a', 'succeeded', 'vibes', NOW())`
      )
    ).rejects.toThrow();
  });

  it('rollback drops the table', { timeout: 60_000 }, async () => {
    const migration = getMigration062();
    await runner.runMigration(migration);
    await runner.rollback(migration);

    const table = await db.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_name = 'brainstrike_assistant_run_outcomes'`
    );
    expect(Number(table.rows[0]?.count ?? -1)).toBe(0);
  });
});
