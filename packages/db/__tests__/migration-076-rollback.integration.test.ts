import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migration076AssistantRunErrors } from '../src/migrations/076-assistant-run-errors.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir.js';

describe('migration 076 rollback semantics', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('rollback-076'));
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations);
    await db.exec(`
      INSERT INTO mastra_threads (id, "resourceId", title, "createdAt", "updatedAt")
        VALUES ('rollback-thread', 'rollback-resource', 'Retained conversation', NOW(), NOW());
      INSERT INTO brainstrike_assistant_thread_runs
        (id, thread_id, resource_id, provider, model, runtime_kind, status, started_at, created_at, updated_at)
        VALUES ('rollback-run', 'rollback-thread', 'rollback-resource', 'openai', 'fixture',
                'hosted', 'failed', NOW(), NOW(), NOW());
      INSERT INTO brainstrike_assistant_run_errors
        (run_id, thread_id, resource_id, code, message, cause_chain, http_status, occurred_at)
        VALUES ('rollback-run', 'rollback-thread', 'rollback-resource', 'provider_error',
                'original forensic evidence', '[{"name":"APICallError"}]', 500, NOW());
      INSERT INTO brainstrike_diagnostic_events
        (id, occurred_at, severity, source, message, fingerprint, session_id, app_version, platform, run_id)
        VALUES ('rollback-diagnostic', NOW(), 'error', 'fixture', 'retained diagnostic',
                'fixture', 'fixture', 'fixture', 'fixture', 'rollback-run');
    `);
  });

  afterEach(async () => {
    await db.close();
  });

  async function readRetainedData(): Promise<unknown[]> {
    const result = await db.query(`SELECT
      (SELECT jsonb_agg(t ORDER BY id) FROM mastra_threads t) AS threads,
      (SELECT jsonb_agg(r ORDER BY id) FROM brainstrike_assistant_thread_runs r) AS runs,
      (SELECT jsonb_agg(d ORDER BY id) FROM brainstrike_diagnostic_events d) AS diagnostics`);
    return result.rows;
  }

  async function readDiagnosticIndexes(): Promise<{ indexdef: string; indexname: string }[]> {
    const result = await db.query<{
      indexdef: string;
      indexname: string;
    }>(`SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'brainstrike_diagnostic_events' ORDER BY indexname`);
    return result.rows;
  }

  it('deletes only forensic rows and the added index; reapplication cannot restore lost evidence', async () => {
    const retained = await readRetainedData();
    const indexes = await readDiagnosticIndexes();
    await runner.rollback(migration076AssistantRunErrors);
    expect(await runner.isApplied(76)).toBe(false);
    expect(await readRetainedData()).toEqual(retained);
    expect(await readDiagnosticIndexes()).toEqual(
      indexes.filter((row) => row.indexname !== 'bst_diagnostic_events_run_idx')
    );
    const absent = await db.query(`SELECT to_regclass('brainstrike_assistant_run_errors') AS errors,
      to_regclass('bst_assistant_run_errors_thread_idx') AS thread_index,
      to_regclass('bst_assistant_run_errors_resource_idx') AS resource_index`);
    expect(absent.rows).toEqual([{ errors: null, resource_index: null, thread_index: null }]);
    if (typeof migration076AssistantRunErrors.down !== 'string') {
      throw new Error('Migration 076 must have a SQL rollback');
    }
    await db.exec(migration076AssistantRunErrors.down);
    await runner.runMigration(migration076AssistantRunErrors);
    expect(await runner.isApplied(76)).toBe(true);
    expect(await readRetainedData()).toEqual(retained);
    expect(await readDiagnosticIndexes()).toEqual(indexes);
    expect((await db.query('SELECT * FROM brainstrike_assistant_run_errors')).rows).toEqual([]);
    const errorIndexes = await db.query(`SELECT indexname FROM pg_indexes
      WHERE tablename = 'brainstrike_assistant_run_errors' ORDER BY indexname`);
    expect(errorIndexes.rows).toEqual([
      { indexname: 'brainstrike_assistant_run_errors_pkey' },
      { indexname: 'bst_assistant_run_errors_resource_idx' },
      { indexname: 'bst_assistant_run_errors_thread_idx' },
    ]);
    await expect(
      db.exec(`INSERT INTO brainstrike_assistant_run_errors
      (run_id, thread_id, resource_id, code, http_status, occurred_at)
      VALUES ('invalid', 'rollback-thread', 'rollback-resource', 'provider_error', 99, NOW())`)
    ).rejects.toThrow('bst_assistant_run_errors_http_status_check');
    await db.exec(`INSERT INTO brainstrike_assistant_run_errors
      (run_id, thread_id, resource_id, code, http_status, occurred_at)
      VALUES ('rollback-run', 'rollback-thread', 'rollback-resource', 'new_error', 429, NOW())`);
    expect((await db.query('SELECT code FROM brainstrike_assistant_run_errors')).rows).toEqual([
      { code: 'new_error' },
    ]);
  });

  it('retains forensics, all indexes and the ledger when a dependency prevents DROP', async () => {
    const retained = await readRetainedData();
    const indexes = await readDiagnosticIndexes();
    const errors = await db.query('SELECT * FROM brainstrike_assistant_run_errors ORDER BY run_id');
    const errorIndexes = await db.query<{
      indexdef: string;
      indexname: string;
    }>(`SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'brainstrike_assistant_run_errors' ORDER BY indexname`);
    await db.exec(
      'CREATE VIEW rollback_error_reader AS SELECT run_id FROM brainstrike_assistant_run_errors'
    );
    await expect(runner.rollback(migration076AssistantRunErrors)).rejects.toThrow(
      'cannot drop table brainstrike_assistant_run_errors because other objects depend on it'
    );
    expect(await runner.isApplied(76)).toBe(true);
    expect(await readRetainedData()).toEqual(retained);
    expect(await readDiagnosticIndexes()).toEqual(indexes);
    expect(
      (await db.query('SELECT * FROM brainstrike_assistant_run_errors ORDER BY run_id')).rows
    ).toEqual(errors.rows);
    expect(
      (
        await db.query<{
          indexdef: string;
          indexname: string;
        }>(`SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'brainstrike_assistant_run_errors' ORDER BY indexname`)
      ).rows
    ).toEqual(errorIndexes.rows);
    expect((await db.query('SELECT * FROM rollback_error_reader')).rows).toEqual([
      { run_id: 'rollback-run' },
    ]);
    await db.exec('DROP VIEW rollback_error_reader');
    await runner.rollback(migration076AssistantRunErrors);
    expect(await runner.isApplied(76)).toBe(false);
    expect(await readRetainedData()).toEqual(retained);
  });
});
