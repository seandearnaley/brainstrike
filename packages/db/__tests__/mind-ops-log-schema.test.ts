import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

/**
 * Runtime behaviour of the append-only mind op-log (BST-993).
 *
 * Was migration-079's suite. Dropped: "creates the op-log with its entity
 * index", pinned by the catalog readback in
 * __tests__/fixtures/schema-catalog.snapshot.txt. Kept: that the sequence and
 * the occurred_at default actually produce values on insert, and that the
 * deliberate op/entity CHECKs reject anything outside the seam contract --
 * neither of which a schema dump can show.
 */
describe('mind ops log', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('assigns monotonic local seq and defaults occurred_at', async () => {
    await db.query(
      `INSERT INTO brainstrike_mind_ops (entity_kind, entity_id, op, resource_id)
       VALUES ('thread', 'thread-a', 'delete', 'workspace-a'),
              ('prompt_item', 'prompt-b', 'delete', NULL)`
    );

    const rows = await db.query<{
      seq: string | number;
      occurred_at: unknown;
      resource_id: string | null;
    }>('SELECT seq, occurred_at, resource_id FROM brainstrike_mind_ops ORDER BY seq');
    expect(rows.rows).toHaveLength(2);
    expect(Number(rows.rows[1]?.seq)).toBeGreaterThan(Number(rows.rows[0]?.seq));
    expect(rows.rows[0]?.occurred_at).toBeTruthy();
    // Thread tombstones carry workspace scope (unrecoverable post-delete);
    // prompt items are global, so resource_id is nullable.
    expect(rows.rows[0]?.resource_id).toBe('workspace-a');
    expect(rows.rows[1]?.resource_id).toBeNull();
  });

  it('rejects vocabulary outside the seam contract (deliberate CHECKs)', async () => {
    // Widening op/entity vocabulary must be a conscious schema change when a
    // sync engine is chosen -- not a silent drift channel (NO SILENT FALLBACKS).
    await expect(
      db.query(
        `INSERT INTO brainstrike_mind_ops (entity_kind, entity_id, op)
         VALUES ('thread', 'thread-a', 'upsert')`
      )
    ).rejects.toThrow(/check constraint/i);
    await expect(
      db.query(
        `INSERT INTO brainstrike_mind_ops (entity_kind, entity_id, op)
         VALUES ('vector', 'v-1', 'delete')`
      )
    ).rejects.toThrow(/check constraint/i);
  });
});
