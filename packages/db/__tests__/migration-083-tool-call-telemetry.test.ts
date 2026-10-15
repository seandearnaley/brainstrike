import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { getResetTables } from '../src/reset-table-registry.js';
import { createDbAtVersion } from './helpers/migrated-test-db.js';

const TABLE = 'brainstrike_tool_call_telemetry';
const THREAD_INDEX = 'brainstrike_tool_call_telemetry_thread_idx';
const TOOL_TIME_INDEX = 'brainstrike_tool_call_telemetry_tool_time_idx';

async function listIndexes(db: PGlite): Promise<string[]> {
  const result = await db.query<{ indexname: string }>(
    'SELECT indexname FROM pg_indexes WHERE tablename = $1',
    [TABLE]
  );
  return result.rows.map((row) => row.indexname);
}

describe('migration 083: tool-call telemetry (BST-1190)', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await createDbAtVersion(82);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => db.close());

  it('creates the narrow FK-less telemetry table and indexes', async () => {
    const migration = migrations.find((candidate) => candidate.version === 83);
    expect(migration).toBeDefined();
    await runner.runMigration(migration!);

    await db.query(
      `INSERT INTO ${TABLE}
        (id, thread_id, run_id, tool_id, model_facing_chars, truncated, zero_match, is_pagination_followup)
       VALUES ('id-1', 'thread-1', 'run-1', 'grepSearch', 42, true, true, false)`
    );
    const rows = await db.query(`SELECT * FROM ${TABLE}`);
    expect(rows.rows).toHaveLength(1);
    expect(await listIndexes(db)).toEqual(expect.arrayContaining([THREAD_INDEX, TOOL_TIME_INDEX]));
    expect(getResetTables()).toContain(TABLE);
  });

  it('rejects negative model-facing character counts', async () => {
    const migration = migrations.find((candidate) => candidate.version === 83)!;
    await runner.runMigration(migration);
    await expect(
      db.query(
        `INSERT INTO ${TABLE}
          (id, thread_id, run_id, tool_id, model_facing_chars)
         VALUES ('id-bad', 'thread-1', 'run-1', 'grepSearch', -1)`
      )
    ).rejects.toThrow(/check constraint/i);
  });
});

describe('migration 083 in the drizzle runner', () => {
  let db: PGlite;
  beforeEach(() => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector } });
  });
  afterEach(async () => db.close());

  it('creates the same table in the production runner', { timeout: 60_000 }, async () => {
    expect((await runMigrations(db)).success).toBe(true);
    expect(await listIndexes(db)).toEqual(expect.arrayContaining([THREAD_INDEX, TOOL_TIME_INDEX]));
  });
});
