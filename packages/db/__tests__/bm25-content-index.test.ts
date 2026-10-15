import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

const INDEX_NAME = 'idx_file_chunks_content_bm25';

/**
 * Runtime behaviour of the pg_textsearch bm25 content index.
 *
 * Was migration-053's suite. Dropped: "up creates the extension and the index"
 * (both pinned by the catalog readback in
 * __tests__/fixtures/schema-catalog.snapshot.txt, which records the extension
 * set with versions and every index with its access method), "up is idempotent"
 * (there is no step to re-apply) and "down drops the index then the extension"
 * (ADR-0020 does not build rollback).
 *
 * Kept: that the index actually SCORES and ORDERS, including rows inserted after
 * it was built. That is the whole reason the index exists and no dump shows it.
 */
describe('bm25 content index', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('serves BM25-ordered queries and scores rows inserted after the build', async () => {
    await db.query(
      `INSERT INTO file_records (id, name, path, size, created_at, updated_at)
       VALUES ('f1', 'a.md', '/a.md', 1, now()::text, now()::text)`
    );
    const insertChunk = async (id: string, index: number, content: string): Promise<void> => {
      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, created_at, updated_at)
         VALUES ($1, 'f1', $2, $3, $4, now()::text, now()::text)`,
        [id, index, content, `hash-${id}`]
      );
    };
    await insertChunk('c1', 0, 'the pipeline retries the queue');
    await insertChunk('c2', 1, 'the pipeline converts a quaternion rotation');

    const result = await db.query<{ id: string }>(
      `SELECT id FROM file_chunks
       WHERE content_tsvector @@ websearch_to_tsquery('english', 'pipeline OR quaternion')
       ORDER BY -(content <@> to_bm25query('pipeline quaternion', '${INDEX_NAME}')) DESC, id
       LIMIT 5`
    );
    expect(result.rows.map((row) => row.id)).toEqual(['c2', 'c1']);
  });
});
