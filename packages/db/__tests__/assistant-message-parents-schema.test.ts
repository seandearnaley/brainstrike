import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

const TABLE = 'brainstrike_assistant_message_parents';

/**
 * Runtime behaviour of the assistant message parent-topology sidecar.
 *
 * Was migration-055's suite. Its "creates the thread lookup index" and
 * "rolls back cleanly" assertions are gone: the index is pinned by the catalog
 * readback in __tests__/fixtures/schema-catalog.snapshot.txt, and ADR-0020 does
 * not build rollback. What remains is the property the sidecar exists for --
 * that parent edges are stored explicitly, independent of any Mastra message
 * row -- which no schema dump can state.
 */
describe('assistant message parents', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('stores explicit root and sibling edges before any Mastra message rows exist', async () => {
    await db.query(
      `INSERT INTO ${TABLE} (message_id, thread_id, resource_id, parent_id)
       VALUES
         ('user-original', 'thread-1', 'workspace-a', NULL),
         ('user-edited', 'thread-1', 'workspace-a', NULL),
         ('assistant-edited', 'thread-1', 'workspace-a', 'user-edited')`
    );

    const result = await db.query<{ message_id: string; parent_id: string | null }>(
      `SELECT message_id, parent_id FROM ${TABLE} ORDER BY message_id`
    );
    expect(result.rows).toEqual([
      { message_id: 'assistant-edited', parent_id: 'user-edited' },
      { message_id: 'user-edited', parent_id: null },
      { message_id: 'user-original', parent_id: null },
    ]);
  });
});
