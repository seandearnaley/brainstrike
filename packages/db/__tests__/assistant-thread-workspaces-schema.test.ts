import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

/**
 * Runtime behaviour of the per-thread workspace snapshot table.
 *
 * Was migration-095's suite. Dropped: "creates the thread workspaces table",
 * pinned by the catalog readback in
 * __tests__/fixtures/schema-catalog.snapshot.txt. Kept: the upsert semantics and
 * the NOT NULL enforcement on `payload`, neither of which a dump can prove.
 */
describe('assistant thread workspaces', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('upserts a workspace snapshot on conflicting thread_id', async () => {
    await db.query(
      `INSERT INTO brainstrike_assistant_thread_workspaces (thread_id, resource_id, payload)
       VALUES ('thread-1', 'brainstrike:workspace', '{"version":1}'::jsonb)`
    );
    await db.query(
      `INSERT INTO brainstrike_assistant_thread_workspaces (thread_id, resource_id, payload)
       VALUES ('thread-1', 'brainstrike:workspace', '{"version":1,"apps":{}}'::jsonb)
       ON CONFLICT (thread_id) DO UPDATE
         SET payload = EXCLUDED.payload,
             updated_at = NOW()`
    );

    const rows = await db.query<{ payload: { apps?: unknown } }>(
      `SELECT payload FROM brainstrike_assistant_thread_workspaces WHERE thread_id = 'thread-1'`
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.payload).toEqual({ apps: {}, version: 1 });
  });

  it('rejects a NULL payload (workspace rows are never sparse)', async () => {
    await expect(
      db.query(
        `INSERT INTO brainstrike_assistant_thread_workspaces (thread_id, resource_id, payload)
         VALUES ('thread-2', 'brainstrike:workspace', NULL)`
      )
    ).rejects.toThrow(/null value/i);
  });
});
