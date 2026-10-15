import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getResetTables } from '../src/reset-table-registry.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

const TABLE = 'brainstrike_workspace_snapshots';
const OID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

/**
 * Runtime behaviour of the workspace snapshot ledger (BST-1164).
 *
 * Was migration-081's suite. Dropped: "creates the snapshot ledger with its
 * thread and root indexes", pinned by the catalog readback in
 * __tests__/fixtures/schema-catalog.snapshot.txt; "rolls back cleanly", because
 * ADR-0020 does not build rollback; and the separate "both runners invariant"
 * suite, because the collapse leaves ONE runner applying one DDL, so a table can
 * no longer exist in one runner and not the other.
 *
 * Kept: the deliberately-nullable `run_id`, the created_at default, the closed
 * `kind` vocabulary, the NOT NULL identity columns, and the reset registration.
 */
describe('workspace snapshots', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('stores per-root snapshot rows with no thread, run, or roots foreign key', async () => {
    // No FKs by design: a snapshot has no Mastra thread/run parent to hang off,
    // and `roots` rows outlive snapshots independently.
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

  it('rejects an unknown snapshot kind (closed CHECK vocabulary)', async () => {
    await expect(
      db.query(
        `INSERT INTO ${TABLE} (id, thread_id, root_id, root_path, commit_oid, kind)
         VALUES ('snap-bad', 'thread-1', 'root-a', '/w/a', $1, 'mid-turn')`,
        [OID]
      )
    ).rejects.toThrow(/check constraint/i);
  });

  it('requires thread, root identity, and commit oid (an unmappable row is rejected)', async () => {
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

  it('is registered for factory reset and every table-enumerating clear path', () => {
    expect(getResetTables()).toContain(TABLE);
  });
});
