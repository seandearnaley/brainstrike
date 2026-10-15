/**
 * UUIDv7 Primary Key Integration Tests
 *
 * The UUID-PK tables that rely on the database default (selection_snapshots,
 * token_cache, embedding_cache, view_filter_presets) now default to uuidv7()
 * instead of gen_random_uuid() (UUIDv4). UUIDv7 is time-sortable, giving better
 * B-tree insert locality and natural chronological ordering.
 *
 * Run with: TEST_ENABLE_VECTOR=true pnpm test uuidv7-primary-keys.integration.test.ts
 */

import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

/** The UUID version nibble is the first hex digit of the 3rd group. */
function uuidVersion(uuid: string): number {
  return Number.parseInt(uuid.split('-')[2]?.[0] ?? '', 16);
}

describe('uuidv7 primary keys (integration)', () => {
  it('generates time-sortable UUIDv7 ids from the table default', async () => {
    const db: PGlite = await createMigratedTestDb();

    // Insert two rows WITHOUT an id, relying on the column default. A real >1ms gap
    // between them guarantees the uuidv7() TIMESTAMP component differs, so the
    // time-ordered ids sort by insertion order regardless of whether the runtime
    // guarantees intra-millisecond monotonicity (PG18 packs sub-ms precision into
    // rand_a, but this test should not depend on that).
    const a = await db.query(
      'INSERT INTO selection_snapshots DEFAULT VALUES RETURNING id::text AS id'
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    const b = await db.query(
      'INSERT INTO selection_snapshots DEFAULT VALUES RETURNING id::text AS id'
    );
    const idA = (a.rows[0] as { id: string }).id;
    const idB = (b.rows[0] as { id: string }).id;

    expect(uuidVersion(idA)).toBe(7);
    expect(uuidVersion(idB)).toBe(7);
    // UUIDv7 is time-ordered: a later insert sorts lexicographically after.
    expect(idB > idA).toBe(true);

    await db.close();
  });

  it('defaults every DB-default UUID-PK table to uuidv7()', async () => {
    const db: PGlite = await createMigratedTestDb();

    const res = await db.query(
      `SELECT table_name, column_default
         FROM information_schema.columns
        WHERE column_name = 'id'
          AND table_name IN
            ('selection_snapshots', 'token_cache', 'embedding_cache', 'view_filter_presets')`
    );
    const defaults = res.rows as { table_name: string; column_default: string | null }[];
    expect(defaults).toHaveLength(4);
    for (const row of defaults) {
      // NOTE: this asserts the column DEFAULT is uuidv7() for all 4 tables. For
      // `embedding_cache` that default is rarely exercised in practice — its ids are
      // generated in application code (UUIDv4), so embedding_cache rows are typically
      // v4, not v7. The default is still correct to set (covers any DB-default insert).
      expect(row.column_default ?? '').toContain('uuidv7()');
    }

    await db.close();
  });
});
