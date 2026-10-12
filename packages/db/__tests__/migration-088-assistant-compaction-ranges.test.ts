import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

const TABLE = 'brainstrike_assistant_compaction_ranges';
const THREAD_INDEX = 'brainstrike_assistant_compaction_ranges_thread_idx';

async function listIndexes(db: PGlite): Promise<string[]> {
  const result = await db.query<{ indexname: string }>(
    'SELECT indexname FROM pg_indexes WHERE tablename = $1',
    [TABLE]
  );
  return result.rows.map((row) => row.indexname);
}

describe('migration 088: assistant compaction ranges (BST-1200)', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('pglite-test-compaction-ranges'));
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 88));
  });

  afterEach(async () => db.close());

  it('creates the FK-less exact-message overlay and thread index', async () => {
    const migration = migrations.find((candidate) => candidate.version === 88);
    expect(migration).toBeDefined();
    await runner.runMigration(migration!);

    await db.query(
      `INSERT INTO ${TABLE}
        (compaction_message_id, thread_id, compacted_message_ids, kind)
       VALUES ('summary-1', 'thread-1', '["opaque-z", "opaque-a"]'::jsonb, 'agentic')`
    );
    const rows = await db.query<{ compactedMessageIds: unknown }>(
      `SELECT compacted_message_ids AS "compactedMessageIds" FROM ${TABLE}`
    );
    expect(rows.rows).toEqual([{ compactedMessageIds: ['opaque-z', 'opaque-a'] }]);
    expect(await listIndexes(db)).toContain(THREAD_INDEX);
  });

  it('rejects unsupported kinds', async () => {
    const migration = migrations.find((candidate) => candidate.version === 88)!;
    await runner.runMigration(migration);
    await expect(
      db.query(
        `INSERT INTO ${TABLE}
          (compaction_message_id, thread_id, compacted_message_ids, kind)
         VALUES ('summary-1', 'thread-1', '[]'::jsonb, 'unknown')`
      )
    ).rejects.toThrow(/check constraint/i);
  });
});
