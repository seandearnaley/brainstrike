import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

const TABLE = 'brainstrike_assistant_tool_projection_rewrites';
const THREAD_INDEX = 'brainstrike_assistant_tool_projection_rewrites_thread_idx';

async function listIndexes(db: PGlite): Promise<string[]> {
  const result = await db.query<{ indexname: string }>(
    'SELECT indexname FROM pg_indexes WHERE tablename = $1',
    [TABLE]
  );
  return result.rows.map((row) => row.indexname);
}

describe('migration 084: assistant tool projection rewrites (BST-1192)', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('pglite-test-tool-rewrites'));
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 84));
  });

  afterEach(async () => db.close());

  it('creates the FK-less overlay table and thread index', async () => {
    const migration = migrations.find((candidate) => candidate.version === 84);
    expect(migration).toBeDefined();
    await runner.runMigration(migration!);

    await db.query(
      `INSERT INTO ${TABLE}
        (tool_call_id, thread_id, rewrite_id, superseded_by_tool_call_id, marker_text, original_chars)
       VALUES ('call-old', 'thread-1', 'rewrite-1', 'call-new', 'read a.ts lines 1-2/2 [superseded]', 42)`
    );
    expect((await db.query(`SELECT * FROM ${TABLE}`)).rows).toHaveLength(1);
    expect(await listIndexes(db)).toContain(THREAD_INDEX);
  });

  it('rejects negative original character counts', async () => {
    const migration = migrations.find((candidate) => candidate.version === 84)!;
    await runner.runMigration(migration);
    await expect(
      db.query(
        `INSERT INTO ${TABLE}
          (tool_call_id, thread_id, rewrite_id, superseded_by_tool_call_id, marker_text, original_chars)
         VALUES ('call-old', 'thread-1', 'rewrite-1', 'call-new', 'marker', -1)`
      )
    ).rejects.toThrow(/check constraint/i);
  });
});
