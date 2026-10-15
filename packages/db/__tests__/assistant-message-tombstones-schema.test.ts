import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getResetTables } from '../src/reset-table-registry.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

const TABLE = 'brainstrike_assistant_message_tombstones';

/**
 * Runtime behaviour of the assistant message tombstone sidecar (BST-1115).
 *
 * Was migration-080's suite. Dropped: "creates the sidecar with its thread and
 * rewind indexes", pinned by the catalog readback in
 * __tests__/fixtures/schema-catalog.snapshot.txt; "rolls back cleanly", because
 * ADR-0020 does not build rollback; and the separate "both runners invariant"
 * suite, because the collapse leaves ONE runner applying one DDL, so a table
 * can no longer exist in one runner and not the other.
 *
 * Kept: batch grouping, the conversation-only shape, the redo invariant and the
 * NOT NULL rewind key -- the correctness properties the sidecar exists for.
 */
describe('assistant message tombstones', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('stores batch-grouped tombstones with no message or thread foreign key', async () => {
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
    await expect(
      db.query(
        `INSERT INTO ${TABLE} (message_id, thread_id, rewind_id)
         VALUES ('message-b', 'thread-1', NULL)`
      )
    ).rejects.toThrow(/not-null|null value/i);
  });

  it('is registered for factory reset and every table-enumerating clear path', () => {
    expect(getResetTables()).toContain(TABLE);
  });
});
