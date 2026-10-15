import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

const TABLE = 'brainstrike_thread_message_index';

/** 384-dim vector literal matching the seeded profile dimensions. */
function vectorLiteral(hot: number): string {
  const values = new Array<number>(384).fill(0);
  values[hot] = 1;
  return `[${values.join(',')}]`;
}

/**
 * Runtime behaviour of the thread-search index tables.
 *
 * Was migration-067's suite. Dropped: "creates the index, profile and state
 * tables", the GIN-over-tsvector index check, the partial-HNSW index check and
 * the errored-rows partial index check -- the catalog readback in
 * __tests__/fixtures/schema-catalog.snapshot.txt records every index's full
 * definition including access method and partial predicate, so all four are
 * pinned there strictly. Also dropped "rollback drops all three tables",
 * because ADR-0020 does not build rollback.
 *
 * Kept: that the singleton profile REJECTS a second row, that the generated
 * tsvector actually recomputes from content_text, that the typed embedding
 * column rejects a mismatched dimension, that state is keyed per thread, and the
 * content-hash CAS upsert. Every one of those is behaviour a dump cannot show.
 */
describe('thread search index', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('keeps the embedding profile a singleton', async () => {
    await expect(
      db.query(
        `INSERT INTO brainstrike_thread_search_profiles (id, model_id, model_key, dimensions)
         VALUES ('second', 'model', 'local::model', 384)`
      )
    ).rejects.toThrow();
  });

  it('populates the generated tsvector column from content_text', async () => {
    await db.query(
      `INSERT INTO ${TABLE} (
         message_id, thread_id, resource_id, role, content_text, content_hash, message_created_at
       ) VALUES (
         'msg-1', 'thread-1', 'workspace', 'user',
         'tuning hnsw ef_search for pglite vectors', 'hash-1', NOW()
       )`
    );

    const matches = await db.query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM ${TABLE}
       WHERE content_tsvector @@ websearch_to_tsquery('english', 'hnsw tuning')`
    );
    expect(Number(matches.rows[0]?.count ?? 0)).toBe(1);

    const misses = await db.query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM ${TABLE}
       WHERE content_tsvector @@ websearch_to_tsquery('english', 'unrelated topic')`
    );
    expect(Number(misses.rows[0]?.count ?? 0)).toBe(0);
  });

  it('types the embedding column to the profile dimensions', async () => {
    await db.query(
      `INSERT INTO ${TABLE} (
         message_id, thread_id, resource_id, role, content_text, content_hash, message_created_at
       ) VALUES ('msg-dim', 'thread-1', 'workspace', 'user', 'text', 'hash', NOW())`
    );

    await expect(
      db.query(`UPDATE ${TABLE} SET embedding = '[1,2,3]'::vector WHERE message_id = 'msg-dim'`)
    ).rejects.toThrow();
  });

  it('tracks refresh state per thread', async () => {
    await db.query(
      `INSERT INTO brainstrike_thread_search_state (thread_id, last_activity_at)
       VALUES ('thread-1', NOW()), ('thread-2', NOW())`
    );

    const rows = await db.query<{ count: number | string }>(
      'SELECT COUNT(*)::int AS count FROM brainstrike_thread_search_state'
    );
    expect(Number(rows.rows[0]?.count)).toBe(2);
  });

  it('supports the content-hash CAS upsert that resets a stale embedding', async () => {
    await db.query(
      `INSERT INTO ${TABLE} (
         message_id, thread_id, resource_id, role, content_text, content_hash,
         message_created_at, embedding, embedding_profile_id, embedding_updated_at
       ) VALUES (
         'msg-1', 'thread-1', 'workspace', 'assistant',
         'original words', 'hash-old', NOW(), '${vectorLiteral(1)}'::vector, 'default', NOW()
       )`
    );

    const casUpsert = (contentText: string, contentHash: string) =>
      db.query(
        `INSERT INTO ${TABLE} (
           message_id, thread_id, resource_id, role, content_text, content_hash, message_created_at
         ) VALUES ('msg-1', 'thread-1', 'workspace', 'assistant', $1, $2, NOW())
         ON CONFLICT (message_id) DO UPDATE SET
           content_text = EXCLUDED.content_text,
           content_hash = EXCLUDED.content_hash,
           embedding = NULL,
           embedding_profile_id = NULL,
           embedding_error = NULL,
           embedding_updated_at = NULL,
           updated_at = NOW()
         WHERE ${TABLE}.content_hash IS DISTINCT FROM EXCLUDED.content_hash`,
        [contentText, contentHash]
      );

    // Same hash: the embedding survives (the WHERE clause blocks the update).
    await casUpsert('original words', 'hash-old');
    const unchanged = await db.query<{ has_embedding: boolean }>(
      `SELECT embedding IS NOT NULL AS has_embedding FROM ${TABLE} WHERE message_id = 'msg-1'`
    );
    expect(unchanged.rows[0]?.has_embedding).toBe(true);

    // Changed hash: content refreshes and the embedding resets to pending.
    await casUpsert('rewritten words', 'hash-new');
    const refreshed = await db.query<{ content_text: string; has_embedding: boolean }>(
      `SELECT content_text, embedding IS NOT NULL AS has_embedding
       FROM ${TABLE} WHERE message_id = 'msg-1'`
    );
    expect(refreshed.rows[0]?.content_text).toBe('rewritten words');
    expect(refreshed.rows[0]?.has_embedding).toBe(false);
  });
});
