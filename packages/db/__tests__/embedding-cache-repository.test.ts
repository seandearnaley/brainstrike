import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { createEmbeddingCacheRepository } from '../src/index.js';

describe('createEmbeddingCacheRepository', () => {
  let client: PGlite;

  beforeEach(async () => {
    client = new PGlite({
      extensions: { vector },
    });
    await runMigrations(client);
  });

  afterEach(async () => {
    await client.close();
  });

  it('creates a usable cache repository for an Electron-style query-only handle', async () => {
    const db = {
      query: async <T = unknown>(sql: string, params?: unknown[]) => client.query<T>(sql, params),
    };

    expect('transaction' in db).toBe(false);

    const repo = createEmbeddingCacheRepository(db);
    await repo.set('content-a', 'local:test-model', [0.1, 0.2, 0.3, 0.4], 4);

    const hit = await repo.get('content-a', 'local:test-model');
    const miss = await repo.get('missing', 'local:test-model');

    expect(hit.hit).toBe(true);
    expect(miss.hit).toBe(false);
    if (hit.hit) {
      expect(hit.entry.contentHash).toBe('content-a');
      expect(hit.entry.modelKey).toBe('local:test-model');
      expect(hit.entry.embedding).toEqual([0.1, 0.2, 0.3, 0.4]);
      expect(hit.entry.dimensions).toBe(4);
    }
  });

  it('supports batch writes, batch reads, stats, and eviction through the query-only handle', async () => {
    const db = {
      query: async <T = unknown>(sql: string, params?: unknown[]) => client.query<T>(sql, params),
    };
    const repo = createEmbeddingCacheRepository(db, { maxEntries: 2 });

    await repo.setBatch([
      {
        contentHash: 'content-a',
        dimensions: 4,
        embedding: [0.1, 0.2, 0.3, 0.4],
        modelKey: 'local:test-model',
      },
      {
        contentHash: 'content-b',
        dimensions: 4,
        embedding: [0.5, 0.6, 0.7, 0.8],
        modelKey: 'local:test-model',
      },
      {
        contentHash: 'content-c',
        dimensions: 4,
        embedding: [0.9, 1.0, 1.1, 1.2],
        modelKey: 'local:test-model',
      },
    ]);

    const batch = await repo.getBatch([
      { contentHash: 'content-a', modelKey: 'local:test-model' },
      { contentHash: 'content-b', modelKey: 'local:test-model' },
      { contentHash: 'missing', modelKey: 'local:test-model' },
    ]);
    const stats = await repo.getStats();
    const eviction = await repo.evictIfNeeded({ targetUtilization: 0.5 });
    const finalStats = await repo.getStats();

    expect(batch.size).toBe(2);
    expect(batch.get('content-a:local:test-model')?.embedding).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(stats.totalEntries).toBe(3);
    expect(stats.totalHits).toBeGreaterThanOrEqual(3);
    expect(eviction).toEqual({ evicted: 2, needed: true, totalEntries: 3 });
    expect(finalStats.totalEntries).toBe(1);
  });

  it('evicts oldest entries with a single query-handle round trip', async () => {
    const queries: string[] = [];
    const db = {
      query: async <T = unknown>(sql: string, params?: unknown[]) => {
        queries.push(sql);
        return client.query<T>(sql, params);
      },
    };
    const repo = createEmbeddingCacheRepository(db);

    await repo.setBatch([
      {
        contentHash: 'content-a',
        dimensions: 4,
        embedding: [0.1, 0.2, 0.3, 0.4],
        modelKey: 'local:test-model',
      },
      {
        contentHash: 'content-b',
        dimensions: 4,
        embedding: [0.5, 0.6, 0.7, 0.8],
        modelKey: 'local:test-model',
      },
    ]);
    queries.length = 0;

    const evicted = await repo.evictOldest(1);

    expect(evicted).toBe(1);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('WITH oldest AS');
    expect(queries[0]).toContain('DELETE FROM embedding_cache');
  });
});
