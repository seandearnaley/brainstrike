import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { type Migration, MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

const TABLE = 'brainstrike_assistant_tool_projection_rewrites';

function migration145(): Migration {
  const migration = migrations.find((candidate) => candidate.version === 145);
  if (!migration) {
    throw new Error('Migration 145 is missing.');
  }
  return migration;
}

async function tableExists(db: PGlite): Promise<boolean> {
  const result = await db.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [`public.${TABLE}`]
  );
  return result.rows[0]?.present === true;
}

describe('migration 145: drop the PGlite tool projection rewrites (BST-1980)', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('pglite-test-drop-tool-rewrites'));
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 145));
  });

  afterEach(async () => db.close());

  it('drops the table with its rows and index, and is idempotent', async () => {
    await db.query(
      `INSERT INTO ${TABLE}
        (tool_call_id, thread_id, rewrite_id, kind, superseded_by_tool_call_id, marker_text, original_chars)
       VALUES ('call-pruned', 'thread-1', 'rewrite-1', 'prune', NULL, 'pruned marker', 84)`
    );

    await runner.runMigration(migration145());
    await db.exec(migration145().up as string);

    expect(await tableExists(db)).toBe(false);
    const indexes = await db.query('SELECT indexname FROM pg_indexes WHERE tablename = $1', [
      TABLE,
    ]);
    expect(indexes.rows).toEqual([]);
  });

  it('down restores the empty migration-084/087 shape', async () => {
    await runner.runMigration(migration145());
    await db.exec(migration145().down as string);

    const columns = await db.query<{ columnName: string; isNullable: string }>(
      `SELECT column_name AS "columnName", is_nullable AS "isNullable"
       FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
      [TABLE]
    );
    expect(columns.rows).toEqual([
      { columnName: 'tool_call_id', isNullable: 'NO' },
      { columnName: 'thread_id', isNullable: 'NO' },
      { columnName: 'rewrite_id', isNullable: 'NO' },
      { columnName: 'superseded_by_tool_call_id', isNullable: 'YES' },
      { columnName: 'marker_text', isNullable: 'NO' },
      { columnName: 'original_chars', isNullable: 'NO' },
      { columnName: 'created_at', isNullable: 'NO' },
      { columnName: 'kind', isNullable: 'NO' },
    ]);
    expect((await db.query(`SELECT * FROM ${TABLE}`)).rows).toEqual([]);
  });
});

describe('migration 145 in the drizzle runner', () => {
  let db: PGlite;

  beforeEach(() => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector } });
  });

  afterEach(async () => db.close());

  it('leaves no tool projection rewrite table on a fresh database', {
    timeout: 60_000,
  }, async () => {
    expect((await runMigrations(db)).success).toBe(true);
    expect(await tableExists(db)).toBe(false);
  });
});
