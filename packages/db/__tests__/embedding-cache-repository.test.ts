import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { createEmbeddingCacheRepository } from '../src/index.js';

async function waitForAssertion(assertion: () => void): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 1000) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error('Timed out waiting for assertion.');
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

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

  it('chunks access-time updates for large batch cache hits', async () => {
    const queries: string[] = [];
    const accessUpdateParams: unknown[][] = [];
    const db = {
      query: async <T = unknown>(sql: string, params?: unknown[]) => {
        queries.push(sql);
        if (sql.includes('SET accessed_at = $1, access_count = access_count + 1')) {
          accessUpdateParams.push(params ?? []);
        }
        return client.query<T>(sql, params);
      },
    };
    const repo = createEmbeddingCacheRepository(db);
    const entries = Array.from({ length: 101 }, (_value, index) => ({
      contentHash: `content-${index}`,
      dimensions: 4,
      embedding: [0.1, 0.2, 0.3, 0.4],
      modelKey: 'local:test-model',
    }));

    await repo.setBatch(entries);
    queries.length = 0;

    const hits = await repo.getBatch(
      entries.map((entry) => ({ contentHash: entry.contentHash, modelKey: entry.modelKey }))
    );
    expect(hits.size).toBe(101);
    await waitForAssertion(() => {
      const accessUpdateQueries = queries.filter((query) =>
        query.includes('SET accessed_at = $1, access_count = access_count + 1')
      );
      expect(accessUpdateQueries).toHaveLength(2);
    });
    expect(accessUpdateParams).toHaveLength(2);
    expect(accessUpdateParams[0]?.[0]).toBe(accessUpdateParams[1]?.[0]);
  });

  it('rejects malformed timestamp values from cache rows', async () => {
    const db = {
      query: async <T = unknown>(sql: string): Promise<{ rows: T[] }> => {
        if (sql.includes('SELECT id, content_hash')) {
          return {
            rows: [
              {
                access_count: 1,
                accessed_at: 'not-a-date',
                content_hash: 'content-a',
                created_at: new Date(),
                dimensions: 4,
                embedding: '[0.1,0.2,0.3,0.4]',
                id: 'cache-row-a',
                model_key: 'local:test-model',
              } as T,
            ],
          };
        }
        return { rows: [] };
      },
    };
    const repo = createEmbeddingCacheRepository(db);

    await expect(repo.get('content-a', 'local:test-model')).rejects.toThrow(
      'Embedding cache accessed_at has invalid date value'
    );
  });

  it('flushes pending access-time updates', async () => {
    const pendingAccessUpdate = deferred<{ rows: unknown[] }>();
    let updateStarted = false;
    const db = {
      query: async <T = unknown>(sql: string): Promise<{ rows: T[] }> => {
        if (sql.includes('SELECT id, content_hash')) {
          return {
            rows: [
              {
                access_count: 1,
                accessed_at: new Date(),
                content_hash: 'content-a',
                created_at: new Date(),
                dimensions: 4,
                embedding: '[0.1,0.2,0.3,0.4]',
                id: 'cache-row-a',
                model_key: 'local:test-model',
              } as T,
            ],
          };
        }
        if (sql.includes('UPDATE embedding_cache')) {
          updateStarted = true;
          return pendingAccessUpdate.promise as Promise<{ rows: T[] }>;
        }
        return { rows: [] };
      },
    };
    const repo = createEmbeddingCacheRepository(db);

    await repo.get('content-a', 'local:test-model');
    await waitForAssertion(() => {
      expect(updateStarted).toBe(true);
    });

    const flushPromise = repo.flushPendingAccessTimeUpdates().then(() => 'flushed' as const);
    const flushState = await Promise.race([
      flushPromise,
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
    ]);

    expect(flushState).toBe('pending');

    pendingAccessUpdate.resolve({ rows: [] });

    await expect(flushPromise).resolves.toBe('flushed');
  });
});
