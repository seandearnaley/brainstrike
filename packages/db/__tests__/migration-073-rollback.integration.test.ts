import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migration073DiagnosticEvents as migration } from '../src/migrations/073-diagnostic-events.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir.js';

describe('migration 073 diagnostic rollback semantics', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('rollback-073'));
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((candidate) => candidate.version <= 73));
    await db.exec(`
      INSERT INTO file_records (id, name, path, size, content, created_at, updated_at)
        VALUES ('rollback-file', 'a.txt', '/rollback/a.txt', 18, 'Retained user file', NOW()::text, NOW()::text);
      INSERT INTO brainstrike_diagnostic_events
        (id, occurred_at, severity, source, message, fingerprint, session_id, thread_id,
         app_version, platform, context, cause_chain)
        VALUES ('rollback-diagnostic', NOW(), 'error', 'fixture', 'lost diagnostic',
                'fixture', 'fixture', 'rollback-thread', 'fixture', 'fixture',
                '{"fixture":true}', '[{"name":"Error"}]');
    `);
  });

  afterEach(async () => {
    await db.close();
  });

  async function retainedData(): Promise<unknown[]> {
    return (
      await db.query(`SELECT
      (SELECT jsonb_agg(f ORDER BY id) FROM file_records f) AS files,
      (SELECT jsonb_agg(m ORDER BY id) FROM models m) AS models`)
    ).rows;
  }

  async function indexes(): Promise<{ indexdef: string; indexname: string }[]> {
    return (
      await db.query<{ indexdef: string; indexname: string }>(`SELECT indexname, indexdef
      FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'brainstrike_diagnostic_events'
      ORDER BY indexname`)
    ).rows;
  }

  it('deletes diagnostic evidence only and recreates an empty table with the original constraints', async () => {
    const retained = await retainedData();
    const originalIndexes = await indexes();
    expect(originalIndexes.map((row) => row.indexname)).toEqual([
      'brainstrike_diagnostic_events_pkey',
      'bst_diagnostic_events_fingerprint_idx',
      'bst_diagnostic_events_occurred_idx',
      'bst_diagnostic_events_severity_idx',
      'bst_diagnostic_events_thread_idx',
    ]);
    await runner.rollback(migration);
    expect(await runner.isApplied(73)).toBe(false);
    expect(await retainedData()).toEqual(retained);
    expect(
      (await db.query("SELECT to_regclass('brainstrike_diagnostic_events') AS events")).rows
    ).toEqual([{ events: null }]);
    expect(await indexes()).toEqual([]);
    if (typeof migration.down !== 'string') {
      throw new Error('Migration 073 must have SQL down');
    }
    await db.exec(migration.down);
    await runner.runMigration(migration);
    expect(await runner.isApplied(73)).toBe(true);
    expect(await retainedData()).toEqual(retained);
    expect(await indexes()).toEqual(originalIndexes);
    expect((await db.query('SELECT * FROM brainstrike_diagnostic_events')).rows).toEqual([]);
    await expect(
      db.exec(`INSERT INTO brainstrike_diagnostic_events
      (id, occurred_at, severity, source, message, fingerprint, session_id, app_version, platform)
      VALUES ('invalid', NOW(), 'info', 'fixture', 'm', 'f', 's', 'v', 'p')`)
    ).rejects.toThrow('brainstrike_diagnostic_events_severity_check');
    await db.exec(`INSERT INTO brainstrike_diagnostic_events
      (id, occurred_at, severity, source, message, fingerprint, session_id, app_version, platform)
      VALUES ('new', NOW(), 'fatal', 'fixture', 'new event', 'f', 's', 'v', 'p')`);
    expect((await db.query('SELECT id, severity FROM brainstrike_diagnostic_events')).rows).toEqual(
      [{ id: 'new', severity: 'fatal' }]
    );
  });

  it('restores all earlier index drops, populated evidence and ledger when a view blocks DROP', async () => {
    const retained = await retainedData();
    const originalIndexes = await indexes();
    const events = (await db.query('SELECT * FROM brainstrike_diagnostic_events ORDER BY id')).rows;
    await db.exec(
      'CREATE VIEW rollback_diagnostic_reader AS SELECT id FROM brainstrike_diagnostic_events'
    );
    await expect(runner.rollback(migration)).rejects.toThrow(
      'cannot drop table brainstrike_diagnostic_events because other objects depend on it'
    );
    expect(await runner.isApplied(73)).toBe(true);
    expect(await indexes()).toEqual(originalIndexes);
    expect(
      (await db.query('SELECT * FROM brainstrike_diagnostic_events ORDER BY id')).rows
    ).toEqual(events);
    expect((await db.query('SELECT * FROM rollback_diagnostic_reader')).rows).toEqual([
      { id: 'rollback-diagnostic' },
    ]);
    expect(await retainedData()).toEqual(retained);
    await db.exec('DROP VIEW rollback_diagnostic_reader');
    await runner.rollback(migration);
    expect(await runner.isApplied(73)).toBe(false);
    expect(await retainedData()).toEqual(retained);
  });

  it('does not restore later-migration indexes or reconcile their ledger during out-of-order reapply', async () => {
    await runner.up(migrations);
    expect(await runner.isApplied(76)).toBe(true);
    expect((await indexes()).some((row) => row.indexname === 'bst_diagnostic_events_run_idx')).toBe(
      true
    );
    await runner.rollback(migration);
    await runner.runMigration(migration);
    // 073 knows only its own indexes. The later ledger entry still says applied.
    expect(await runner.isApplied(76)).toBe(true);
    expect((await indexes()).some((row) => row.indexname === 'bst_diagnostic_events_run_idx')).toBe(
      false
    );
  });
});
