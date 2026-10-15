import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { type Migration, MigrationRunner, migrations } from '../src/migrations/index.js';
import { createDbAtVersion } from './helpers/migrated-test-db.js';

const ROLE = 'brainstrike_agent_readonly';

function migration151(): Migration {
  const migration = migrations.find((candidate) => candidate.version === 151);
  if (!migration) {
    throw new Error('Migration 151 is missing.');
  }
  return migration;
}

async function roleExists(db: PGlite): Promise<boolean> {
  const result = await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE]);
  return result.rows.length > 0;
}

async function defaultGrantCount(db: PGlite): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pg_default_acl, aclexplode(defaclacl) AS acl
      WHERE acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
    [ROLE]
  );
  return result.rows[0]?.count ?? -1;
}

describe('migration 151: drop the querySelf read-only role (BST-1995)', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    db = await createDbAtVersion(150);
    runner = new MigrationRunner(db);
  });

  afterEach(async () => db.close());

  it('drops the role with its grants, keeps application reads, and is idempotent', async () => {
    expect(await roleExists(db)).toBe(true);

    await runner.runMigration(migration151());
    await db.exec(migration151().up as string);

    expect(await roleExists(db)).toBe(false);
    await expect(db.exec(`SET ROLE ${ROLE}`)).rejects.toThrow('does not exist');
    expect((await db.query('SELECT count(*)::int AS count FROM job_queue')).rows).toEqual([
      { count: 0 },
    ]);
  });

  it('down restores the role, its existing-table grant and its future-table default', async () => {
    await runner.runMigration(migration151());
    await db.exec(migration151().down as string);

    expect(await roleExists(db)).toBe(true);
    expect(await defaultGrantCount(db)).toBeGreaterThan(0);
    await db.exec('CREATE TABLE migration_151_future (id integer)');
    const grants = await db.query<{ existing: boolean; future: boolean }>(
      `SELECT has_table_privilege($1, 'job_queue', 'SELECT') AS existing,
              has_table_privilege($1, 'migration_151_future', 'SELECT') AS future`,
      [ROLE]
    );
    expect(grants.rows).toEqual([{ existing: true, future: true }]);
  });
});

describe('migration 151 in the drizzle runner', () => {
  let db: PGlite;

  beforeEach(() => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector } });
  });

  afterEach(async () => db.close());

  it('leaves no read-only role on a fresh database', { timeout: 60_000 }, async () => {
    expect((await runMigrations(db)).success).toBe(true);
    expect(await roleExists(db)).toBe(false);
  });
});
