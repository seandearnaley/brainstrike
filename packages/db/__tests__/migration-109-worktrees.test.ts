import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { getResetTables } from '../src/reset-table-registry.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

const TABLE = 'brainstrike_worktrees';
const DRIZZLE_RUN_TIMEOUT_MS = 300_000;

interface CountRow {
  count: number | string;
}

async function countTable(db: Pick<PGlite, 'query'>): Promise<number> {
  const result = await db.query<CountRow>(
    `SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_name = '${TABLE}'`
  );
  return Number(result.rows[0]?.count ?? 0);
}

describe('migration 109: managed worktree ledger', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-worktrees');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 109));
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration109() {
    const migration = migrations.find((candidate) => candidate.version === 109);
    if (!migration) {
      throw new Error('Migration 109 is missing');
    }
    return migration;
  }

  it('creates the ledger table', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration109());
    expect(await countTable(db)).toBe(1);
  });

  it('enforces a UNIQUE path so one directory can never have two ledger rows', {
    timeout: 60_000,
  }, async () => {
    await runner.runMigration(getMigration109());
    const insert = (id: string) =>
      db.query(
        `INSERT INTO ${TABLE} (id, repo_common_dir, path, base_ref, created_by, setup_status)
         VALUES ($1, '/repo/.git', '/wt/alpha', 'main', 'user', 'none')`,
        [id]
      );
    await insert('w-1');
    await expect(insert('w-2')).rejects.toThrow(/duplicate key|unique/i);
  });

  it('rejects a created_by outside the closed set', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration109());
    await expect(
      db.query(
        `INSERT INTO ${TABLE} (id, repo_common_dir, path, base_ref, created_by, setup_status)
         VALUES ('w-3', '/repo/.git', '/wt/beta', 'main', 'robot', 'none')`
      )
    ).rejects.toThrow(/check constraint/i);
  });

  it('rejects a setup_status outside the closed set', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration109());
    await expect(
      db.query(
        `INSERT INTO ${TABLE} (id, repo_common_dir, path, base_ref, created_by, setup_status)
         VALUES ('w-4', '/repo/.git', '/wt/gamma', 'main', 'user', 'maybe')`
      )
    ).rejects.toThrow(/check constraint/i);
  });

  it('allows a NULL branch (a detached worktree) and a NULL thread', {
    timeout: 60_000,
  }, async () => {
    await runner.runMigration(getMigration109());
    await db.query(
      `INSERT INTO ${TABLE} (id, repo_common_dir, path, base_ref, created_by, setup_status)
       VALUES ('w-5', '/repo/.git', '/wt/detached', 'origin/main', 'user', 'none')`
    );
    const rows = await db.query<{ branch: string | null; thread_id: string | null }>(
      `SELECT branch, thread_id FROM ${TABLE} WHERE id = 'w-5'`
    );
    expect(rows.rows[0]).toEqual({ branch: null, thread_id: null });
  });

  it('rolls back cleanly', { timeout: 60_000 }, async () => {
    const migration = getMigration109();
    await runner.runMigration(migration);
    await runner.rollback(migration);
    expect(await countTable(db)).toBe(0);
  });

  it('is registered for factory reset and every table-enumerating clear path', () => {
    expect(getResetTables()).toContain(TABLE);
  });
});

describe('migration 109 in the drizzle runner (both runners invariant)', () => {
  let db: PGlite;

  beforeEach(() => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector } });
  });

  afterEach(async () => {
    await db.close();
  });

  it(
    'creates the same table production runs',
    async () => {
      // Production runs the drizzle `customMigrations` list, not the numbered
      // runner: a table registered in only one runner exists only in tests.
      const result = await runMigrations(db);
      expect(result.success).toBe(true);
      expect(await countTable(db)).toBe(1);
      const indexes = await db.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = '${TABLE}'`
      );
      expect(indexes.rows.map((row) => row.indexname)).toContain(
        'brainstrike_worktrees_repo_active_idx'
      );
    },
    DRIZZLE_RUN_TIMEOUT_MS
  );
});
