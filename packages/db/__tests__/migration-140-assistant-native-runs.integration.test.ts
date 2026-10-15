import { MASTRA_MEMORY_SCHEMA_SQL } from '@brainstrike/assistant-contract/mastra-memory-schema';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migration140AssistantNativeRuns } from '../src/migrations/140-assistant-native-runs.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createDbAtVersion, LATEST_MIGRATION_VERSION } from './helpers/migrated-test-db.js';
import { createPGliteTestDataDir } from './test-data-dir.js';

const SEED_ROOT_AND_LEG = `INSERT INTO mastra_threads (id, "resourceId", title, "createdAt", "updatedAt")
    VALUES ('root', 'owner', 'Root', now(), now());
  INSERT INTO brainstrike_assistant_thread_runs
    (id, resource_id, thread_id, provider, model, runtime_kind, status, started_at, created_at, updated_at)
  VALUES ('leg', 'owner', 'root', 'openai', 'm', 'desktop', 'running', now(), now(), now());`;

async function columns(db: PGlite, table: string): Promise<string[]> {
  const result = await db.query<{ column_name: string }>(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position',
    [table]
  );
  return result.rows.map((row) => row.column_name);
}

describe('migration 140 assistant native runs', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await createDbAtVersion(LATEST_MIGRATION_VERSION);
    await db.exec(MASTRA_MEMORY_SCHEMA_SQL);
  });
  afterEach(async () => {
    await db.close();
  });

  it('adds the generation column to the run header and creates the native-run mapping', async () => {
    expect(await columns(db, 'brainstrike_assistant_native_runs')).toEqual([
      'native_run_id',
      'host_run_id',
      'created_at',
    ]);
    // The column is APPENDED: every earlier column keeps its ordinal, which is
    // what `assistant-run-schema-upgrade-path.test.ts` compares across eras.
    expect(await columns(db, 'brainstrike_assistant_thread_runs')).toEqual([
      'id',
      'resource_id',
      'thread_id',
      'provider',
      'model',
      'model_settings',
      'provider_options',
      'runtime_kind',
      'status',
      'error',
      'started_at',
      'completed_at',
      'created_at',
      'updated_at',
      'turn_message_id',
      'generation_run_id',
    ]);
    expect(migration140AssistantNativeRuns.ledgerKey).toBe('custom-140-assistant-native-runs');
  });

  it('backfills a leg that predates the column to its OWN id, never to null', async () => {
    // The interesting database is the one that already carries run rows: a
    // generation opened before 140 is one leg as far as the ledger is
    // concerned, so every existing row references itself.
    const seeded = await wasmLoader.createPGlite(createPGliteTestDataDir('migration-140-backfill'));
    try {
      const runner = new MigrationRunner(seeded);
      await runner.initialize();
      await runner.up(migrations.filter((migration) => migration.version < 140));
      // Control: the column really is absent before 140 runs, or the assertion
      // below would pass on a row the migration never touched.
      expect(await columns(seeded, 'brainstrike_assistant_thread_runs')).not.toContain(
        'generation_run_id'
      );
      await seeded.exec(SEED_ROOT_AND_LEG);
      await runner.up(migrations);
      const rows = await seeded.query<{ generationRunId: string | null }>(
        'SELECT generation_run_id AS "generationRunId" FROM brainstrike_assistant_thread_runs WHERE id = $1',
        ['leg']
      );
      expect(rows.rows).toEqual([{ generationRunId: 'leg' }]);
    } finally {
      await seeded.close();
    }
  });

  it('cascades the mapping with its host leg and refuses a blank or orphaned native run', async () => {
    await db.exec(`${SEED_ROOT_AND_LEG}
      INSERT INTO brainstrike_assistant_native_runs (native_run_id, host_run_id)
      VALUES ('native-run-1', 'leg');`);
    await expect(
      db.exec(`INSERT INTO brainstrike_assistant_native_runs (native_run_id, host_run_id)
        VALUES ('   ', 'leg');`)
    ).rejects.toThrow(/check constraint/i);
    await expect(
      db.exec(`INSERT INTO brainstrike_assistant_native_runs (native_run_id, host_run_id)
        VALUES ('native-run-2', 'missing-leg');`)
    ).rejects.toThrow(/foreign key/i);
    await db.exec("DELETE FROM brainstrike_assistant_thread_runs WHERE id = 'leg'");
    expect(
      (await db.query('SELECT count(*)::int AS n FROM brainstrike_assistant_native_runs')).rows
    ).toEqual([{ n: 0 }]);
  });

  it('replays over an already-migrated database and rolls back cleanly', async () => {
    if (typeof migration140AssistantNativeRuns.up !== 'string') {
      throw new Error('migration 140 must carry SQL-string up');
    }
    if (typeof migration140AssistantNativeRuns.down !== 'string') {
      throw new Error('migration 140 must carry SQL-string down');
    }
    await db.exec(migration140AssistantNativeRuns.up);
    await db.exec(migration140AssistantNativeRuns.down);
    expect(
      (await db.query('SELECT to_regclass($1) AS r', ['brainstrike_assistant_native_runs'])).rows
    ).toEqual([{ r: null }]);
    expect(await columns(db, 'brainstrike_assistant_thread_runs')).not.toContain(
      'generation_run_id'
    );
  });
});
