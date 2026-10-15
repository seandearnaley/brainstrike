import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { TEST_ENGINE_EXTENSIONS } from './helpers/migrated-test-db.js';

const ROLE = 'brainstrike_agent_readonly';

/**
 * The `querySelf` read-only role must NOT exist on a fresh database (BST-1995).
 *
 * Was migration-151's suite. Its apply-and-`down` cases are gone with the chain
 * (ADR-0020: one current-schema DDL, no rollback), but this assertion is NOT
 * redundant and is deliberately kept: the catalog fixture in
 * __tests__/fixtures/schema-catalog.snapshot.txt dumps relations, columns,
 * constraints, indexes, sequences and seed rows -- it does not read `pg_roles`,
 * so a role leaking back into the shipped schema would pass the fixture
 * unnoticed. Boots from an empty cluster for real, because a role is a cluster
 * object and the subject is what a fresh install creates.
 */
describe('agent read-only role', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite({ extensions: TEST_ENGINE_EXTENSIONS });
  });

  afterEach(async () => {
    await db.close();
  });

  it('is absent on a fresh database, and reads still work without it', async () => {
    await migrate(db);

    const roles = await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ROLE]);
    expect(roles.rows).toEqual([]);
    await expect(db.exec(`SET ROLE ${ROLE}`)).rejects.toThrow('does not exist');
    expect((await db.query('SELECT count(*)::int AS count FROM job_queue')).rows).toEqual([
      { count: 0 },
    ]);
  }, 60_000);
});
