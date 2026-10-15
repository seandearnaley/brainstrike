import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { getResetTables } from '../src/reset-table-registry.js';
import { createDbAtVersion } from './helpers/migrated-test-db.js';

const TABLE = 'brainstrike_workspace_snapshots';
const THREAD_INDEX = 'brainstrike_workspace_snapshots_thread_idx';
const ROOT_INDEX = 'brainstrike_workspace_snapshots_root_idx';
const OID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
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

describe('migration 081: workspace snapshots (BST-1164)', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await createDbAtVersion(80);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration081() {
    const migration = migrations.find((candidate) => candidate.version === 81);
    if (!migration) {
      throw new Error('Migration 081 is missing');
    }
    return migration;
  }

  it('creates the snapshot ledger with its thread and root indexes', async () => {
    expect(await countTable(db)).toBe(0);

    await runner.runMigration(getMigration081());

    expect(await countTable(db)).toBe(1);
    const indexes = await listIndexes(db);
    expect(indexes).toContain(THREAD_INDEX);
    expect(indexes).toContain(ROOT_INDEX);
  });

  it('stores per-root snapshot rows with no thread, run, or roots foreign key', async () => {
    await runner.runMigration(getMigration081());

    // No FKs by design (migration 055/080 precedent): numbered migrations run
    // against a bare schema where no Mastra thread/run parent exists, and
    // `roots` rows outlive snapshots independently.
    await db.query(
      `INSERT INTO ${TABLE} (id, thread_id, run_id, root_id, root_path, commit_oid, kind)
       VALUES ('snap-1', 'thread-1', 'run-1', 'root-a', '/w/a', $1, 'turn-start'),
              ('snap-2', 'thread-1', NULL, 'root-b', '/w/b', $1, 'turn-end'),
              ('snap-3', 'thread-2', 'run-2', 'root-a', '/w/a', $1, 'pre-revert')`,
      [OID]
    );

    const rows = await db.query<{ id: string; created_at: unknown; run_id: string | null }>(
      `SELECT id, created_at, run_id FROM ${TABLE} WHERE thread_id = $1 ORDER BY id`,
      ['thread-1']
    );
    expect(rows.rows.map((row) => row.id)).toEqual(['snap-1', 'snap-2']);
    // `run_id` is nullable on purpose: a turn is NOT a run, so a snapshot can
    // exist without any specific run as provenance.
    expect(rows.rows.map((row) => row.run_id)).toEqual(['run-1', null]);
    expect(rows.rows[0]?.created_at).toBeTruthy();
  });

  it('rejects an unknown snapshot kind (closed CHECK vocabulary, migration 079 convention)', async () => {
    await runner.runMigration(getMigration081());

    await expect(
      db.query(
        `INSERT INTO ${TABLE} (id, thread_id, root_id, root_path, commit_oid, kind)
         VALUES ('snap-bad', 'thread-1', 'root-a', '/w/a', $1, 'mid-turn')`,
        [OID]
      )
    ).rejects.toThrow(/check constraint/i);
  });

  it('requires thread, root identity, and commit oid (a snapshot row without them is unmappable)', async () => {
    await runner.runMigration(getMigration081());

    await expect(
      db.query(
        `INSERT INTO ${TABLE} (id, thread_id, root_id, root_path, commit_oid, kind)
         VALUES ('snap-null', NULL, 'root-a', '/w/a', $1, 'turn-start')`,
        [OID]
      )
    ).rejects.toThrow(/not-null|null value/i);
    await expect(
      db.query(
        `INSERT INTO ${TABLE} (id, thread_id, root_id, root_path, commit_oid, kind)
         VALUES ('snap-null', 'thread-1', 'root-a', '/w/a', NULL, 'turn-start')`
      )
    ).rejects.toThrow(/not-null|null value/i);
  });

  it('rolls back cleanly', async () => {
    const migration = getMigration081();
    await runner.runMigration(migration);
    await runner.rollback(migration);

    expect(await countTable(db)).toBe(0);
  });

  it('is registered for factory reset and every table-enumerating clear path', () => {
    expect(getResetTables()).toContain(TABLE);
  });
});

describe('migration 081 in the drizzle runner (both runners invariant)', () => {
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
      expect(indexes).toContain(ROOT_INDEX);
    },
    DRIZZLE_RUN_TIMEOUT_MS
  );
});
