import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { getResetTables } from '../src/reset-table-registry.js';
import { createDbAtVersion } from './helpers/migrated-test-db.js';

const TABLE = 'brainstrike_assistant_message_tombstones';
const THREAD_INDEX = 'brainstrike_assistant_message_tombstones_thread_idx';
const REWIND_INDEX = 'brainstrike_assistant_message_tombstones_rewind_idx';
const DRIZZLE_RUN_TIMEOUT_MS = 60_000;

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

describe('migration 080: assistant message tombstones (BST-1115)', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await createDbAtVersion(79);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration080() {
    const migration = migrations.find((candidate) => candidate.version === 80);
    if (!migration) {
      throw new Error('Migration 080 is missing');
    }
    return migration;
  }

  it('creates the tombstone sidecar with its thread and rewind indexes', async () => {
    expect(await countTable(db)).toBe(0);

    await runner.runMigration(getMigration080());

    expect(await countTable(db)).toBe(1);
    const indexes = await listIndexes(db);
    expect(indexes).toContain(THREAD_INDEX);
    expect(indexes).toContain(REWIND_INDEX);
  });

  it('stores batch-grouped tombstones with no message or thread foreign key', async () => {
    await runner.runMigration(getMigration080());

    // No FKs by design (migration 055 precedent): numbered migrations run
    // against a bare schema where no Mastra table exists yet.
    await db.query(
      `INSERT INTO ${TABLE} (message_id, thread_id, rewind_id, revert_id)
       VALUES ('message-b', 'thread-1', 'rewind-1', 'revert-1'),
              ('message-c', 'thread-1', 'rewind-1', 'revert-1'),
              ('message-d', 'thread-2', 'rewind-2', 'revert-2')`
    );

    const batch = await db.query<{ message_id: string; tombstoned_at: unknown }>(
      `SELECT message_id, tombstoned_at FROM ${TABLE} WHERE rewind_id = $1 ORDER BY message_id`,
      ['rewind-1']
    );
    expect(batch.rows.map((row) => row.message_id)).toEqual(['message-b', 'message-c']);
    expect(batch.rows[0]?.tombstoned_at).toBeTruthy();
  });

  it('accepts a conversation-only batch: rewind_id set, revert_id NULL', async () => {
    await runner.runMigration(getMigration080());

    // A `conversation-only` rewind performs no file revert at all, so there is
    // no journal batch to point at. Redo still targets rewind_id, which is why
    // the two ids are separate columns rather than one.
    await db.query(
      `INSERT INTO ${TABLE} (message_id, thread_id, rewind_id)
       VALUES ('message-b', 'thread-1', 'rewind-1'),
              ('message-c', 'thread-1', 'rewind-1')`
    );

    const rows = await db.query<{ message_id: string; revert_id: string | null }>(
      `SELECT message_id, revert_id FROM ${TABLE} WHERE rewind_id = $1 ORDER BY message_id`,
      ['rewind-1']
    );
    expect(rows.rows).toEqual([
      { message_id: 'message-b', revert_id: null },
      { message_id: 'message-c', revert_id: null },
    ]);
  });

  it('makes a message tombstoned at most once (the redo invariant)', async () => {
    await runner.runMigration(getMigration080());

    await db.query(
      `INSERT INTO ${TABLE} (message_id, thread_id, rewind_id)
       VALUES ('message-b', 'thread-1', 'rewind-1')`
    );

    // A second rewind covering the same message must not create a second row:
    // redo deletes ONE rewind_id batch, so a duplicate would resurrect a
    // message the older rewind hid. The PK makes that a hard error, and
    // ON CONFLICT DO NOTHING is the caller's explicit keep-the-original.
    await expect(
      db.query(
        `INSERT INTO ${TABLE} (message_id, thread_id, rewind_id)
         VALUES ('message-b', 'thread-1', 'rewind-2')`
      )
    ).rejects.toThrow(/duplicate key|unique/i);

    await db.query(
      `INSERT INTO ${TABLE} (message_id, thread_id, rewind_id)
       VALUES ('message-b', 'thread-1', 'rewind-2')
       ON CONFLICT (message_id) DO NOTHING`
    );
    const rows = await db.query<{ rewind_id: string }>(
      `SELECT rewind_id FROM ${TABLE} WHERE message_id = 'message-b'`
    );
    expect(rows.rows.map((row) => row.rewind_id)).toEqual(['rewind-1']);
  });

  it('requires a rewind batch id (a NULL redo key is how a batch gets lost)', async () => {
    await runner.runMigration(getMigration080());

    await expect(
      db.query(
        `INSERT INTO ${TABLE} (message_id, thread_id, rewind_id)
         VALUES ('message-b', 'thread-1', NULL)`
      )
    ).rejects.toThrow(/not-null|null value/i);
  });

  it('rolls back cleanly', async () => {
    const migration = getMigration080();
    await runner.runMigration(migration);
    await runner.rollback(migration);

    expect(await countTable(db)).toBe(0);
  });

  it('is registered for factory reset and every table-enumerating clear path', () => {
    expect(getResetTables()).toContain(TABLE);
  });
});

describe('migration 080 in the drizzle runner (both runners invariant)', () => {
  let db: PGlite;

  beforeEach(() => {
    db = new PGlite({
      extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector },
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it(
    'creates the same table and indexes production runs',
    async () => {
      // Production runs the drizzle `customMigrations` list, not the numbered
      // runner: a table registered in only one runner exists only in tests.
      const result = await runMigrations(db);
      expect(result.success).toBe(true);

      expect(await countTable(db)).toBe(1);
      const indexes = await listIndexes(db);
      expect(indexes).toContain(THREAD_INDEX);
      expect(indexes).toContain(REWIND_INDEX);
    },
    DRIZZLE_RUN_TIMEOUT_MS
  );
});
