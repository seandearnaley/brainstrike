import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

const TABLE = 'brainstrike_canvas_versions';
const THREAD_INDEX = 'brainstrike_canvas_versions_thread_idx';
const VERSION_INDEX = 'brainstrike_canvas_versions_canvas_version_idx';

async function listIndexes(db: PGlite): Promise<string[]> {
  const result = await db.query<{ indexname: string }>(
    'SELECT indexname FROM pg_indexes WHERE tablename = $1',
    [TABLE]
  );
  return result.rows.map((row) => row.indexname);
}

async function countTable(db: PGlite): Promise<number> {
  const result = await db.query<{ count: number | string }>(
    'SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_name = $1',
    [TABLE]
  );
  return Number(result.rows[0]?.count ?? -1);
}

describe('migration 082: canvas documents (BST-1173)', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('pglite-test-canvas-documents'));
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 82));
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration082() {
    const migration = migrations.find((candidate) => candidate.version === 82);
    if (!migration) {
      throw new Error('Migration 082 is missing');
    }
    return migration;
  }

  it('creates the version ledger with its thread and descending-version indexes', async () => {
    expect(await countTable(db)).toBe(0);

    await runner.runMigration(getMigration082());

    expect(await countTable(db)).toBe(1);
    const indexes = await listIndexes(db);
    expect(indexes).toContain(THREAD_INDEX);
    expect(indexes).toContain(VERSION_INDEX);
  });

  it('stores versioned canvas rows with no thread or resource foreign key', async () => {
    await runner.runMigration(getMigration082());

    await db.query(
      `INSERT INTO ${TABLE}
        (id, canvas_id, thread_id, resource_id, title, html, version, created_by)
       VALUES ('version-1', 'canvas-1', 'thread-1', 'resource-1', 'Draft', '<p>one</p>', 1, 'assistant'),
              ('version-2', 'canvas-1', 'thread-1', 'resource-1', 'Draft', '<p>two</p>', 2, 'user')`
    );

    const rows = await db.query<{
      created_at: unknown;
      created_by: string;
      id: string;
      version: number;
    }>(`SELECT id, version, created_by, created_at FROM ${TABLE} ORDER BY version`);
    expect(rows.rows.map((row) => [row.id, row.version, row.created_by])).toEqual([
      ['version-1', 1, 'assistant'],
      ['version-2', 2, 'user'],
    ]);
    expect(rows.rows[0]?.created_at).toBeTruthy();
  });

  it('enforces one row per canvas version and versions starting at one', async () => {
    await runner.runMigration(getMigration082());
    await db.query(
      `INSERT INTO ${TABLE}
        (id, canvas_id, thread_id, resource_id, title, html, version, created_by)
       VALUES ('version-1', 'canvas-1', 'thread-1', 'resource-1', 'Draft', '<p>one</p>', 1, 'assistant')`
    );

    await expect(
      db.query(
        `INSERT INTO ${TABLE}
          (id, canvas_id, thread_id, resource_id, title, html, version, created_by)
         VALUES ('version-duplicate', 'canvas-1', 'thread-1', 'resource-1', 'Draft', '<p>again</p>', 1, 'assistant')`
      )
    ).rejects.toThrow(/unique|duplicate/i);
    await expect(
      db.query(
        `INSERT INTO ${TABLE}
          (id, canvas_id, thread_id, resource_id, title, html, version, created_by)
         VALUES ('version-zero', 'canvas-2', 'thread-1', 'resource-1', 'Draft', '', 0, 'assistant')`
      )
    ).rejects.toThrow(/check constraint/i);
  });

  it('rejects an unknown creator (closed CHECK vocabulary)', async () => {
    await runner.runMigration(getMigration082());

    await expect(
      db.query(
        `INSERT INTO ${TABLE}
          (id, canvas_id, thread_id, resource_id, title, html, version, created_by)
         VALUES ('version-bad', 'canvas-1', 'thread-1', 'resource-1', 'Draft', '', 1, 'system')`
      )
    ).rejects.toThrow(/check constraint/i);
  });

  it('rolls back cleanly', async () => {
    const migration = getMigration082();
    await runner.runMigration(migration);
    await runner.rollback(migration);

    expect(await countTable(db)).toBe(0);
  });
});
