import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

const TABLE = 'brainstrike_assistant_prompt_manifests';

/**
 * Runtime behaviour of the surviving swarm-diagnostics evidence table.
 *
 * Was migration-139's suite, which covered three tables. TWO of them --
 * `brainstrike_delegated_wakeups` and `brainstrike_delegated_live_decisions` --
 * were later dropped by migration 152, so those assertions have no subject on
 * the shipped schema; their ABSENCE is already owned by
 * `retired-delegation-schema.integration.test.ts`.
 *
 * Also dropped: "creates the three tables with their evidence columns" (column
 * lists are pinned by ordinal position in
 * __tests__/fixtures/schema-catalog.snapshot.txt, and it asserted the migration
 * module's own ledgerKey, which is gone with the chain) and "replays over an
 * already-migrated database and rolls back cleanly" (no step to replay; ADR-0020
 * does not build rollback).
 *
 * Kept, for the table that remains: that deleting the host run actually
 * CASCADEs its manifests away rather than leaving diagnostics outliving their
 * run, and that the closed `kind` vocabulary rejects.
 */
describe('swarm diagnostics prompt manifests', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  async function seedRunWithManifest(): Promise<void> {
    await db.exec(`INSERT INTO mastra_threads (id, "resourceId", title, "createdAt", "updatedAt")
      VALUES ('root', 'owner', 'Root', now(), now());
      INSERT INTO brainstrike_assistant_thread_runs
        (id, resource_id, thread_id, provider, model, runtime_kind, status, started_at, created_at, updated_at)
      VALUES ('leg', 'owner', 'root', 'openai', 'm', 'agent', 'running', now(), now(), now());
      INSERT INTO ${TABLE}
        (id, host_run_id, thread_id, kind, system_context_source, system_messages, tool_names, total_chars)
      VALUES ('pm', 'leg', 'root', 'root-leg', 'captured', '[]', '[]', 0);`);
  }

  it('cascades its rows away when the host run is deleted', async () => {
    await seedRunWithManifest();
    expect((await db.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows).toEqual([{ n: 1 }]);

    await db.exec("DELETE FROM brainstrike_assistant_thread_runs WHERE id = 'leg'");

    expect((await db.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows).toEqual([{ n: 0 }]);
  });

  it('rejects a kind outside the closed vocabulary', async () => {
    await seedRunWithManifest();

    await expect(
      db.exec(`INSERT INTO ${TABLE}
        (id, host_run_id, thread_id, kind, system_context_source, system_messages, tool_names, total_chars)
        VALUES ('pm-bad', 'leg', 'root', 'human', 'captured', '[]', '[]', 0);`)
    ).rejects.toThrow(/check constraint/i);
  });
});
