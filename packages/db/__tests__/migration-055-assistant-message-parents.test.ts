import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

const TABLE = 'brainstrike_assistant_message_parents';

describe('migration 055: assistant message parent topology', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(
      createPGliteTestDataDir('pglite-test-assistant-message-parents')
    );
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 55));
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration055() {
    const migration = migrations.find((candidate) => candidate.version === 55);
    if (!migration) {
      throw new Error('Migration 055 is missing');
    }
    return migration;
  }

  it('stores explicit root and sibling edges before any Mastra message rows exist', async () => {
    await runner.runMigration(getMigration055());

    await db.query(
      `INSERT INTO ${TABLE} (message_id, thread_id, resource_id, parent_id)
       VALUES
         ('user-original', 'thread-1', 'workspace-a', NULL),
         ('user-edited', 'thread-1', 'workspace-a', NULL),
         ('assistant-edited', 'thread-1', 'workspace-a', 'user-edited')`
    );

    const result = await db.query<{ message_id: string; parent_id: string | null }>(
      `SELECT message_id, parent_id FROM ${TABLE} ORDER BY message_id`
    );
    expect(result.rows).toEqual([
      { message_id: 'assistant-edited', parent_id: 'user-edited' },
      { message_id: 'user-edited', parent_id: null },
      { message_id: 'user-original', parent_id: null },
    ]);
  });

  it('creates the thread lookup index and rolls back cleanly', async () => {
    const migration = getMigration055();
    await runner.runMigration(migration);
    const indexes = await db.query<{ indexname: string }>(
      'SELECT indexname FROM pg_indexes WHERE tablename = $1',
      [TABLE]
    );
    expect(indexes.rows.map((row) => row.indexname)).toContain(
      'brainstrike_assistant_message_parents_thread_idx'
    );

    await runner.rollback(migration);
    const tables = await db.query<{ count: number | string }>(
      'SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_name = $1',
      [TABLE]
    );
    expect(Number(tables.rows[0]?.count ?? -1)).toBe(0);
  });
});
