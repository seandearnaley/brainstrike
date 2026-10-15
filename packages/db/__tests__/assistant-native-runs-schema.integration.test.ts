import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

const SEED_ROOT_AND_LEG = `INSERT INTO mastra_threads (id, "resourceId", title, "createdAt", "updatedAt")
    VALUES ('root', 'owner', 'Root', now(), now());
  INSERT INTO brainstrike_assistant_thread_runs
    (id, resource_id, thread_id, provider, model, runtime_kind, status, started_at, created_at, updated_at)
  VALUES ('leg', 'owner', 'root', 'openai', 'm', 'desktop', 'running', now(), now(), now());`;

/**
 * Runtime behaviour of the native-run mapping.
 *
 * Was migration-140's suite. Dropped: "adds the generation column to the run
 * header and creates the native-run mapping", whose column lists (including the
 * APPENDED ordinal of `generation_run_id`) the catalog readback in
 * __tests__/fixtures/schema-catalog.snapshot.txt pins by ordinal position for
 * every table, and which also asserted the migration module's own ledgerKey --
 * that module is gone with the chain; "backfills a leg that predates the column
 * to its OWN id", which has no subject because a greenfield install has no run
 * rows predating the column (ADR-0020); and "replays over an already-migrated
 * database and rolls back cleanly", because there is no step to replay and
 * ADR-0020 does not build rollback.
 *
 * Kept: the blank-id CHECK, the foreign key, and the CASCADE. The fixture
 * records that all three exist; only writes and a DELETE show they act.
 */
describe('assistant native runs', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('cascades the mapping with its host leg and refuses a blank or orphaned native run', async () => {
    await db.exec(`${SEED_ROOT_AND_LEG}
      INSERT INTO brainstrike_assistant_native_runs (native_run_id, host_run_id)
      VALUES ('native-run-1', 'leg');`);

    await expect(
      db.exec(`INSERT INTO brainstrike_assistant_native_runs (native_run_id, host_run_id)
        VALUES ('   ', 'leg');`)
    ).rejects.toThrow(/check constraint/i);
    await expect(
      db.exec(`INSERT INTO brainstrike_assistant_native_runs (native_run_id, host_run_id)
        VALUES ('native-run-2', 'missing-leg');`)
    ).rejects.toThrow(/foreign key/i);

    await db.exec("DELETE FROM brainstrike_assistant_thread_runs WHERE id = 'leg'");
    expect(
      (await db.query('SELECT count(*)::int AS n FROM brainstrike_assistant_native_runs')).rows
    ).toEqual([{ n: 0 }]);
  });
});
