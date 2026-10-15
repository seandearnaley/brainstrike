import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import {
  getCollectionIndexingStats,
  markCollectionIndexingStatsDirty,
  refreshCollectionIndexingStats,
} from '../src/services/collection-indexing-stats';

/**
 * Migration-030's "the migration SQL mentions these identifiers" assertion was
 * dropped with the chain (ADR-0020): it grepped a migration's source text, and
 * there is no such migration. The shipped table is pinned by catalog readback in
 * __tests__/fixtures/schema-catalog.snapshot.txt; the service behaviour below is
 * what remains worth asserting.
 */
describe('collection indexing stats', () => {
  it('returns null when stats are missing instead of inventing zeroes', async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };

    await expect(getCollectionIndexingStats(db, 'set-1')).resolves.toBeNull();

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM collection_indexing_stats'),
      ['set-1']
    );
  });

  it('maps stored count rows into typed stats', async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            chunkCount: '9',
            dirty: 'f',
            embeddedChunkCount: '4',
            embeddingSetId: 'set-1',
            fileCount: '3',
            lastRefreshedAt: '2026-04-26T00:00:00.000Z',
            pendingChunkCount: '5',
          },
        ],
      })),
    };

    await expect(getCollectionIndexingStats(db, 'set-1')).resolves.toEqual({
      chunkCount: 9,
      dirty: false,
      embeddedChunkCount: 4,
      embeddingSetId: 'set-1',
      fileCount: 3,
      lastRefreshedAt: '2026-04-26T00:00:00.000Z',
      pendingChunkCount: 5,
    });
  });

  it('refreshes unique collection ids with one aggregate statement', async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            chunkCount: 2,
            dirty: false,
            embeddedChunkCount: 1,
            embeddingSetId: 'set-1',
            fileCount: 1,
            lastRefreshedAt: '2026-04-26T00:00:00.000Z',
            pendingChunkCount: 1,
          },
        ],
      })),
    };

    const stats = await refreshCollectionIndexingStats(db, ['set-1', 'set-1'], {
      label: 'stats refresh',
      priority: 'background',
    });

    expect(stats).toHaveLength(1);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO collection_indexing_stats'),
      [['set-1']]
    );
    expect(db.query.mock.calls[0]?.[0]).toContain('aggregated_files AS');
    expect(db.query.mock.calls[0]?.[0]).toContain('aggregated_chunks AS');
  });

  it('refreshes stats against PGlite UUID embedding set ids', async () => {
    const db = new PGlite();
    const embeddingSetId = '18c518a4-12f2-4b1e-8370-158f44dbaf4b';
    const fileRecordId = '11111111-1111-4111-8111-111111111111';
    const pendingChunkId = '22222222-2222-4222-8222-222222222222';
    const embeddedChunkId = '33333333-3333-4333-8333-333333333333';

    try {
      await db.query(`
        CREATE TABLE embedding_sets (
          id UUID PRIMARY KEY
        )
      `);
      await db.query(`
        CREATE TABLE file_records (
          id UUID PRIMARY KEY,
          embedding_set_id UUID
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
      await db.query(`
        CREATE TABLE file_chunks (
          id UUID PRIMARY KEY,
          file_record_id UUID NOT NULL,
          embedding_set_id UUID,
          embedding TEXT
        )
      `);
      await db.query('INSERT INTO embedding_sets (id) VALUES ($1)', [embeddingSetId]);
      await db.query('INSERT INTO file_records (id, embedding_set_id) VALUES ($1, $2)', [
        fileRecordId,
        embeddingSetId,
      ]);
      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, embedding_set_id, embedding)
         VALUES ($1, $2, $3, NULL), ($4, $2, $3, 'vector-present')`,
        [pendingChunkId, fileRecordId, embeddingSetId, embeddedChunkId]
      );

      const stats = await refreshCollectionIndexingStats(db, [embeddingSetId]);

      expect(stats).toEqual([
        expect.objectContaining({
          chunkCount: 2,
          dirty: false,
          embeddedChunkCount: 1,
          embeddingSetId,
          fileCount: 1,
          pendingChunkCount: 1,
        }),
      ]);
    } finally {
      await db.close();
    }
  });

  it('marks unique collection stats dirty', async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };

    await markCollectionIndexingStatsDirty(db, ['set-1', 'set-1', 'set-2']);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('SET dirty = TRUE'), [
      ['set-1', 'set-2'],
    ]);
  });
});
