import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { type Migration, MigrationRunner, migrations } from '../src/migrations/index.js';
import { createDbAtVersion } from './helpers/migrated-test-db.js';

const TABLES = [
  'brainstrike_assistant_compaction_ranges',
  'brainstrike_assistant_task_lists',
  'brainstrike_canvas_versions',
] as const;

function migration147(): Migration {
  const migration = migrations.find((candidate) => candidate.version === 147);
  if (!migration) {
    throw new Error('Migration 147 is missing.');
  }
  return migration;
}

async function presentTables(db: PGlite): Promise<string[]> {
  const result = await db.query<{ tableName: string }>(
    `SELECT table_name AS "tableName" FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY table_name`,
    [[...TABLES]]
  );
  return result.rows.map((row) => row.tableName);
}

async function columnsOf(db: PGlite, table: string): Promise<string[]> {
  const result = await db.query<{ columnName: string }>(
    `SELECT column_name AS "columnName" FROM information_schema.columns
     WHERE table_name = $1 ORDER BY ordinal_position`,
    [table]
  );
  return result.rows.map((row) => row.columnName);
}

describe('migration 147: drop the unwritten PGlite chat sidecars (BST-1980)', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await createDbAtVersion(146);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => db.close());

  it('drops the three tables with their rows and indexes, and is idempotent', async () => {
    await db.query(
      `INSERT INTO brainstrike_assistant_task_lists (thread_id, resource_id) VALUES ('thread-1', 'resource-1')`
    );
    await db.query(
      `INSERT INTO brainstrike_assistant_compaction_ranges
        (compaction_message_id, thread_id, compacted_message_ids, kind)
       VALUES ('summary-1', 'thread-1', '["message-1"]'::jsonb, 'agentic')`
    );
    await db.query(
      `INSERT INTO brainstrike_canvas_versions
        (id, canvas_id, thread_id, resource_id, title, html, version, created_by)
       VALUES ('version-1', 'canvas-1', 'thread-1', 'resource-1', 'Plan', '<p>plan</p>', 1, 'assistant')`
    );
    expect(await presentTables(db)).toEqual([...TABLES]);

    await runner.runMigration(migration147());
    await db.exec(migration147().up as string);

    expect(await presentTables(db)).toEqual([]);
    const indexes = await db.query('SELECT indexname FROM pg_indexes WHERE tablename = ANY($1)', [
      [...TABLES],
    ]);
    expect(indexes.rows).toEqual([]);
  });

  it('down restores the empty migration-050/082/088 shapes', async () => {
    await runner.runMigration(migration147());
    await db.exec(migration147().down as string);

    expect(await columnsOf(db, 'brainstrike_assistant_task_lists')).toEqual([
      'thread_id',
      'resource_id',
      'tasks',
      'updated_at',
    ]);
    expect(await columnsOf(db, 'brainstrike_assistant_compaction_ranges')).toEqual([
      'compaction_message_id',
      'thread_id',
      'compacted_message_ids',
      'kind',
      'created_at',
    ]);
    expect(await columnsOf(db, 'brainstrike_canvas_versions')).toEqual([
      'id',
      'canvas_id',
      'thread_id',
      'resource_id',
      'title',
      'html',
      'version',
      'created_by',
      'created_at',
    ]);
    for (const table of TABLES) {
      expect((await db.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
    }
  });
});

describe('migration 147 in the drizzle runner', () => {
  let db: PGlite;

  beforeEach(() => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector } });
  });

  afterEach(async () => db.close());

  it('leaves none of the three tables on a fresh database', { timeout: 60_000 }, async () => {
    expect((await runMigrations(db)).success).toBe(true);
    expect(await presentTables(db)).toEqual([]);
  });
});
