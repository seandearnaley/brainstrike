import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

/**
 * Runtime behaviour of the assistant thread-group and placement tables.
 *
 * Consolidates what migration-054/056/059's suites asserted about these two
 * tables. They were three files only because they were authored as three chain
 * steps; the chain collapsed into a single current-schema DDL (ADR-0020).
 *
 * Dropped with those suites: "creates the tables / adds the column", pinned
 * exhaustively by the catalog readback in
 * __tests__/fixtures/schema-catalog.snapshot.txt; every `rollback` case, because
 * ADR-0020 does not build rollback; and 056/059's "preserves existing groups"
 * cases, because a greenfield install has no pre-existing group to preserve.
 *
 * Kept: the ON CONFLICT upsert semantics and the two closed CHECK vocabularies,
 * which a catalog dump states but cannot prove actually reject anything.
 */
describe('assistant thread groups', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  async function insertGroup(id: string, extraColumns = '', extraValues = ''): Promise<void> {
    await db.query(
      `INSERT INTO brainstrike_assistant_thread_groups (id, resource_id, name, rank${extraColumns})
       VALUES ('${id}', 'workspace-a', 'Group ${id}', 'a0'${extraValues})`
    );
  }

  it('upserts a placement on conflicting thread_id', async () => {
    await insertGroup('group-1');
    await db.query(
      `INSERT INTO brainstrike_assistant_thread_placements (thread_id, resource_id, group_id, rank)
       VALUES ('thread-1', 'workspace-a', 'group-1', 'a0')`
    );
    await db.query(
      `INSERT INTO brainstrike_assistant_thread_placements (thread_id, resource_id, group_id, rank)
       VALUES ('thread-1', 'workspace-a', NULL, 'a1')
       ON CONFLICT (thread_id) DO UPDATE
         SET group_id = EXCLUDED.group_id,
             rank = EXCLUDED.rank,
             updated_at = NOW()`
    );

    const rows = await db.query<{ group_id: string | null; rank: string }>(
      `SELECT group_id, rank FROM brainstrike_assistant_thread_placements
       WHERE thread_id = 'thread-1'`
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.group_id).toBeNull();
    expect(rows.rows[0]?.rank).toBe('a1');
  });

  it('accepts a validated group color and rejects one outside the closed set', async () => {
    await insertGroup('group-valid', ', color', `, 'rose'`);

    await expect(insertGroup('group-invalid', ', color', `, 'magenta'`)).rejects.toThrow();
  });

  it('accepts a validated group icon and rejects one outside the closed set', async () => {
    await insertGroup('group-icon');
    await db.query(
      `UPDATE brainstrike_assistant_thread_groups SET icon = 'research' WHERE id = 'group-icon'`
    );

    await expect(
      db.query(
        `UPDATE brainstrike_assistant_thread_groups SET icon = 'folder' WHERE id = 'group-icon'`
      )
    ).rejects.toThrow();
  });
});
