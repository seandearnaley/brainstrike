import { describe, expect, it, vi } from 'vitest';
import { migration030CollectionIndexingStats } from '../src/migrations/030-collection-indexing-stats';
import {
  getCollectionIndexingStats,
  markCollectionIndexingStatsDirty,
  refreshCollectionIndexingStats,
} from '../src/services/collection-indexing-stats';

describe('collection indexing stats', () => {
  it('adds a migration that backfills deterministic collection stats', () => {
    expect(migration030CollectionIndexingStats.version).toBe(30);
    expect(migration030CollectionIndexingStats.up).toContain('collection_indexing_stats');
    expect(migration030CollectionIndexingStats.up).toContain('FROM embedding_sets s');
    expect(migration030CollectionIndexingStats.up).toContain('embedded_chunk_count');
    expect(migration030CollectionIndexingStats.up).toContain('pending_chunk_count');
  });

  it('returns null when stats are missing instead of inventing zeroes', async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };

    await expect(getCollectionIndexingStats(db, 'set-1')).resolves.toBeNull();

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM collection_indexing_stats'),
      ['set-1'],
      undefined
    );
  });

  it('maps stored count rows into typed stats', async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            embeddingSetId: 'set-1',
            fileCount: '3',
            chunkCount: '9',
            embeddedChunkCount: '4',
            pendingChunkCount: '5',
            dirty: 'f',
            lastRefreshedAt: '2026-04-26T00:00:00.000Z',
          },
        ],
      })),
    };

    await expect(getCollectionIndexingStats(db, 'set-1')).resolves.toEqual({
      embeddingSetId: 'set-1',
      fileCount: 3,
      chunkCount: 9,
      embeddedChunkCount: 4,
      pendingChunkCount: 5,
      dirty: false,
      lastRefreshedAt: '2026-04-26T00:00:00.000Z',
    });
  });

  it('refreshes unique collection ids with one aggregate statement', async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            embeddingSetId: 'set-1',
            fileCount: 1,
            chunkCount: 2,
            embeddedChunkCount: 1,
            pendingChunkCount: 1,
            dirty: false,
            lastRefreshedAt: '2026-04-26T00:00:00.000Z',
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
      [['set-1']],
      { label: 'stats refresh', priority: 'background' }
    );
  });

  it('marks unique collection stats dirty', async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };

    await markCollectionIndexingStatsDirty(db, ['set-1', 'set-1', 'set-2']);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('SET dirty = TRUE'),
      [['set-1', 'set-2']],
      undefined
    );
  });
});
