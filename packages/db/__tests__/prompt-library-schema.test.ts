import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

/**
 * Runtime behaviour of the prompt-library tables.
 *
 * Was migration-051's suite. Dropped: the seeded
 * `prompt_embedding_profiles` row and the "no leaked prompt-library collection
 * in embedding_sets" check -- the catalog readback in
 * __tests__/fixtures/schema-catalog.snapshot.txt carries that profile row's full
 * content and every table's row count, so both are pinned there -- and "rolls
 * back every prompt-library artifact", because ADR-0020 does not build rollback.
 *
 * Kept: the column defaults that fire on insert, the closed `kind` vocabulary,
 * and the revision CASCADE. A dump records that the FK and CHECK exist; only a
 * DELETE and a bad INSERT show they act.
 */
describe('prompt library', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  async function seedSnippet(): Promise<void> {
    await db.query(
      `INSERT INTO prompt_items (
         id, kind, title, content, description, tags, model_key, revision
       ) VALUES ($1, 'snippet', $2, $3, $4, $5::jsonb, $6, 1)`,
      [
        'snippet-1',
        'Evidence block',
        'Cite the exact file and line.',
        'Reusable evidence instruction',
        JSON.stringify(['research', 'evidence']),
        null,
      ]
    );
    await db.query(
      `INSERT INTO prompt_item_revisions (
         id, prompt_item_id, revision, title, content, description, tags, note
       ) VALUES ($1, $2, 1, $3, $4, $5, $6::jsonb, $7)`,
      [
        'revision-1',
        'snippet-1',
        'Evidence block',
        'Cite the exact file and line.',
        'Reusable evidence instruction',
        JSON.stringify(['research', 'evidence']),
        'Initial capture',
      ]
    );
  }

  it('defaults a new prompt item to not-favorite and unused', async () => {
    await seedSnippet();

    const item = await db.query<{
      content: string;
      is_favorite: boolean;
      kind: string;
      revision: number;
      tags: string[];
      use_count: number;
    }>(
      `SELECT kind, content, tags, is_favorite, revision, use_count
       FROM prompt_items
       WHERE id = 'snippet-1'`
    );
    expect(item.rows).toEqual([
      {
        content: 'Cite the exact file and line.',
        is_favorite: false,
        kind: 'snippet',
        revision: 1,
        tags: ['research', 'evidence'],
        use_count: 0,
      },
    ]);
  });

  it('rejects a kind outside the closed vocabulary', async () => {
    await expect(
      db.query(
        `INSERT INTO prompt_items (id, kind, title, content)
         VALUES ('invalid-kind', 'note', 'Invalid', 'Invalid')`
      )
    ).rejects.toThrow(/prompt_items_kind_check|check constraint/i);
  });

  it('cascades revision history away when its prompt item is deleted', async () => {
    await seedSnippet();

    await db.query(`DELETE FROM prompt_items WHERE id = 'snippet-1'`);

    const revisions = await db.query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count
       FROM prompt_item_revisions
       WHERE prompt_item_id = 'snippet-1'`
    );
    expect(Number(revisions.rows[0]?.count ?? -1)).toBe(0);
  });
});
