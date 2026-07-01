import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { ACTIVE_COLLECTION_LIVE_COUNTS_QUERY } from '../src/services/collection-indexing-stats';

/**
 * Create the minimal schema the live-counts query reads. `embedding_set_id` is
 * TEXT in production (migrations 006/012), and the stats table carries a `dirty`
 * flag that must NOT gate the live counts.
 */
async function createSchema(db: PGlite): Promise<void> {
  await db.query(`
    CREATE TABLE file_records (
      id TEXT PRIMARY KEY,
      embedding_set_id TEXT
    )
  `);
  await db.query(`
    CREATE TABLE file_chunks (
      id TEXT PRIMARY KEY,
      file_record_id TEXT NOT NULL,
      embedding_set_id TEXT,
      embedding TEXT
    )
  `);
  await db.query(`
    CREATE TABLE collection_indexing_stats (
      embedding_set_id TEXT PRIMARY KEY,
      file_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      embedded_chunk_count INTEGER NOT NULL DEFAULT 0,
      pending_chunk_count INTEGER NOT NULL DEFAULT 0,
      dirty BOOLEAN NOT NULL DEFAULT FALSE,
      last_refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

describe('ACTIVE_COLLECTION_LIVE_COUNTS_QUERY', () => {
  it('reports live counts mid-index even when the stats row is dirty with stale zeroes', async () => {
    const db = new PGlite();
    try {
      await createSchema(db);

      // Three imported files, five chunks (two embedded, three pending) for set-1.
      await db.query(
        `INSERT INTO file_records (id, embedding_set_id) VALUES
          ('f1', 'set-1'), ('f2', 'set-1'), ('f3', 'set-1')`
      );
      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, embedding_set_id, embedding) VALUES
          ('c1', 'f1', 'set-1', 'vector-present'),
          ('c2', 'f1', NULL, NULL),
          ('c3', 'f2', 'set-1', 'vector-present'),
          ('c4', 'f2', 'set-1', NULL),
          ('c5', 'f3', 'set-1', NULL)`
      );
      // Stats row is mid-index: marked dirty, counts not yet refreshed (still zero).
      await db.query(
        `INSERT INTO collection_indexing_stats
           (embedding_set_id, file_count, chunk_count, embedded_chunk_count, dirty)
         VALUES ('set-1', 0, 0, 0, TRUE)`
      );

      const result = await db.query(ACTIVE_COLLECTION_LIVE_COUNTS_QUERY, ['set-1']);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toEqual({
        embeddingsetid: 'set-1',
        recordsCount: 3,
        chunksCount: 5,
        embeddingsCount: 2,
      });
    } finally {
      await db.close();
    }
  });

  it('returns a single zeroed row for a freshly created collection with no rows yet', async () => {
    const db = new PGlite();
    try {
      await createSchema(db);

      const result = await db.query(ACTIVE_COLLECTION_LIVE_COUNTS_QUERY, ['set-new']);

      expect(result.rows).toEqual([
        { embeddingsetid: 'set-new', recordsCount: 0, chunksCount: 0, embeddingsCount: 0 },
      ]);
    } finally {
      await db.close();
    }
  });

  it('scopes counts to the requested collection only', async () => {
    const db = new PGlite();
    try {
      await createSchema(db);

      await db.query(
        `INSERT INTO file_records (id, embedding_set_id) VALUES
          ('f1', 'set-1'), ('f2', 'set-2'), ('f3', 'set-2')`
      );
      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, embedding_set_id, embedding) VALUES
          ('c1', 'f1', 'set-1', 'vector-present'),
          ('c2', 'f2', 'set-2', 'vector-present'),
          ('c3', 'f3', 'set-2', NULL)`
      );

      const result = await db.query(ACTIVE_COLLECTION_LIVE_COUNTS_QUERY, ['set-1']);

      expect(result.rows[0]).toEqual({
        embeddingsetid: 'set-1',
        recordsCount: 1,
        chunksCount: 1,
        embeddingsCount: 1,
      });
    } finally {
      await db.close();
    }
  });
});
