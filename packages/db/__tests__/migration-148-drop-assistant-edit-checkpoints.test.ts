import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { type Migration, MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

const TABLE = 'brainstrike_assistant_edit_checkpoints';

function migration148(): Migration {
  const migration = migrations.find((candidate) => candidate.version === 148);
  if (!migration) {
    throw new Error('Migration 148 is missing.');
  }
  return migration;
}

async function tableExists(db: PGlite): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [TABLE]
  );
  return result.rows.length > 0;
}

async function indexesOf(db: PGlite): Promise<string[]> {
  const result = await db.query<{ indexname: string }>(
    'SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY indexname',
    [TABLE]
  );
  return result.rows.map((row) => row.indexname);
}

describe('migration 148: drop the unread edit-checkpoint journal (BST-1980)', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(
      createPGliteTestDataDir('pglite-test-drop-assistant-edit-checkpoints')
    );
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 148));
  });

  afterEach(async () => db.close());

  it('drops the table with its rows and indexes, and is idempotent', async () => {
    await db.query(
      `INSERT INTO ${TABLE}
        (id, run_id, resource_id, thread_id, tool_name, op, root_id, path,
         before_existed, after_existed, capture_status, occurred_at, created_at, updated_at)
       VALUES ('checkpoint-1', 'run-1', 'resource-1', 'thread-1', 'writeWorkspaceFile', 'write',
         'root-1', '/a.txt', false, true, 'created', NOW(), NOW(), NOW())`
    );
    expect(await tableExists(db)).toBe(true);

    await runner.runMigration(migration148());
    await db.exec(migration148().up as string);

    expect(await tableExists(db)).toBe(false);
    expect(await indexesOf(db)).toEqual([]);
  });

  it('down restores the empty migration-052 shape', async () => {
    await runner.runMigration(migration148());
    await db.exec(migration148().down as string);

    expect(await tableExists(db)).toBe(true);
    expect((await db.query(`SELECT * FROM ${TABLE}`)).rows).toEqual([]);
    expect(await indexesOf(db)).toEqual([
      'brainstrike_assistant_edit_checkpoints_pkey',
      'brainstrike_assistant_edit_checkpoints_revert_idx',
      'brainstrike_assistant_edit_checkpoints_run_idx',
      'brainstrike_assistant_edit_checkpoints_thread_idx',
    ]);
  });
});

describe('migration 148 in the drizzle runner', () => {
  let db: PGlite;

  beforeEach(() => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector } });
  });

  afterEach(async () => db.close());

  it('leaves no edit-checkpoint table on a fresh database', { timeout: 60_000 }, async () => {
    expect((await runMigrations(db)).success).toBe(true);
    expect(await tableExists(db)).toBe(false);
  });
});
