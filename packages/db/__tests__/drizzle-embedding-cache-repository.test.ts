/**
 * Drizzle EmbeddingCacheRepository Tests (BST-170)
 *
 * Tests the Drizzle-based EmbeddingCacheRepository implementation.
 */

import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleEmbeddingCacheRepository } from '../src/repositories/drizzle/embedding-cache-repository.js';
import * as schema from '../src/schema/index.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

describe('DrizzleEmbeddingCacheRepository', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  let repo: DrizzleEmbeddingCacheRepository;

  // Test vectors with 4 dimensions for simplicity
  const testDimensions = 4;
  const testEmbedding1 = [0.1, 0.2, 0.3, 0.4];
  const testEmbedding2 = [0.5, 0.6, 0.7, 0.8];
  const testModelKey = 'local::test-model';
  const testContentHash1 = 'abc123def456';
  const testContentHash2 = 'xyz789uvw012';

  beforeEach(async () => {
    client = await createMigratedTestDb();
    db = drizzle(client, { schema });
    repo = new DrizzleEmbeddingCacheRepository(db);
  });

  afterEach(async () => {
    await client.close();
  });

  describe('get and set', () => {
    it('should set and get a single entry', async () => {
      await repo.set(testContentHash1, testModelKey, testEmbedding1, testDimensions);

      const result = await repo.get(testContentHash1, testModelKey);

      expect(result.hit).toBe(true);
      if (result.hit) {
        expect(result.entry.contentHash).toBe(testContentHash1);
        expect(result.entry.modelKey).toBe(testModelKey);
        expect(result.entry.dimensions).toBe(testDimensions);
        // Verify embedding values
        expect(result.entry.embedding).toHaveLength(testDimensions);
        expect(result.entry.embedding[0]).toBeCloseTo(0.1, 5);
        expect(result.entry.embedding[3]).toBeCloseTo(0.4, 5);
      }
    });

    it('should return miss for non-existent entry', async () => {
      const result = await repo.get('nonexistent', testModelKey);

      expect(result.hit).toBe(false);
      expect(result.entry).toBeNull();
    });

    it('should return miss when content hash matches but model key differs', async () => {
      await repo.set(testContentHash1, testModelKey, testEmbedding1, testDimensions);

      const result = await repo.get(testContentHash1, 'different-model');

      expect(result.hit).toBe(false);
    });

    it('should update accessedAt and accessCount on cache hit', async () => {
      const entry = await repo.set(testContentHash1, testModelKey, testEmbedding1, testDimensions);
      const initialAccessCount = entry.accessCount;
      const _initialAccessedAt = entry.accessedAt;

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Get the entry (should update access time)
      const _result = await repo.get(testContentHash1, testModelKey);

      // Wait for fire-and-forget update to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Fetch again to see updated values
      const updated = await repo.get(testContentHash1, testModelKey);

      expect(updated.hit).toBe(true);
      if (updated.hit) {
        expect(updated.entry.accessCount).toBeGreaterThan(initialAccessCount);
      }
    });

    it('should upsert on conflict and increment access count', async () => {
      await repo.set(testContentHash1, testModelKey, testEmbedding1, testDimensions);

      // Set again with same key - should upsert
      const updated = await repo.set(
        testContentHash1,
        testModelKey,
        testEmbedding2,
        testDimensions
      );

      // Access count should increment
      expect(updated.accessCount).toBeGreaterThanOrEqual(2);
    });

    it('should reject dimension mismatch', async () => {
      await expect(
        repo.set(testContentHash1, testModelKey, testEmbedding1, 10) // Wrong dimensions
      ).rejects.toThrow('dimension mismatch');
    });
  });

  describe('getBatch', () => {
    it('should get multiple entries in one query', async () => {
      await repo.set(testContentHash1, testModelKey, testEmbedding1, testDimensions);
      await repo.set(testContentHash2, testModelKey, testEmbedding2, testDimensions);

      const result = await repo.getBatch([
        { contentHash: testContentHash1, modelKey: testModelKey },
        { contentHash: testContentHash2, modelKey: testModelKey },
      ]);

      expect(result.size).toBe(2);
      expect(result.has(`${testContentHash1}:${testModelKey}`)).toBe(true);
      expect(result.has(`${testContentHash2}:${testModelKey}`)).toBe(true);
    });

    it('should return only hits', async () => {
      await repo.set(testContentHash1, testModelKey, testEmbedding1, testDimensions);

      const result = await repo.getBatch([
        { contentHash: testContentHash1, modelKey: testModelKey },
        { contentHash: 'nonexistent', modelKey: testModelKey },
      ]);

      expect(result.size).toBe(1);
      expect(result.has(`${testContentHash1}:${testModelKey}`)).toBe(true);
      expect(result.has(`nonexistent:${testModelKey}`)).toBe(false);
    });

    it('should handle empty requests', async () => {
      const result = await repo.getBatch([]);

      expect(result.size).toBe(0);
    });

    it('should handle multiple model keys in batch', async () => {
      const modelKey2 = 'local::other-model';

      await repo.set(testContentHash1, testModelKey, testEmbedding1, testDimensions);
      await repo.set(testContentHash1, modelKey2, testEmbedding2, testDimensions);

      const result = await repo.getBatch([
        { contentHash: testContentHash1, modelKey: testModelKey },
        { contentHash: testContentHash1, modelKey: modelKey2 },
      ]);

      expect(result.size).toBe(2);
      expect(result.has(`${testContentHash1}:${testModelKey}`)).toBe(true);
      expect(result.has(`${testContentHash1}:${modelKey2}`)).toBe(true);
    });
  });

  describe('setBatch', () => {
    it('should set multiple entries atomically', async () => {
      const count = await repo.setBatch([
        {
          contentHash: testContentHash1,
          dimensions: testDimensions,
          embedding: testEmbedding1,
          modelKey: testModelKey,
        },
        {
          contentHash: testContentHash2,
          dimensions: testDimensions,
          embedding: testEmbedding2,
          modelKey: testModelKey,
        },
      ]);

      expect(count).toBe(2);

      const result1 = await repo.get(testContentHash1, testModelKey);
      const result2 = await repo.get(testContentHash2, testModelKey);

      expect(result1.hit).toBe(true);
      expect(result2.hit).toBe(true);
    });

    it('should handle empty batch', async () => {
      const count = await repo.setBatch([]);

      expect(count).toBe(0);
    });

    it('should reject dimension mismatch in batch', async () => {
      await expect(
        repo.setBatch([
          {
            contentHash: testContentHash1,
            dimensions: 10, // Wrong dimensions
            embedding: testEmbedding1,
            modelKey: testModelKey,
          },
        ])
      ).rejects.toThrow('dimension mismatch');
    });
  });

  describe('delete', () => {
    it('should delete a single entry', async () => {
      await repo.set(testContentHash1, testModelKey, testEmbedding1, testDimensions);

      const deleted = await repo.delete(testContentHash1, testModelKey);

      expect(deleted).toBe(true);

      const result = await repo.get(testContentHash1, testModelKey);
      expect(result.hit).toBe(false);
    });

    it('should return false for non-existent entry', async () => {
      const deleted = await repo.delete('nonexistent', testModelKey);

      expect(deleted).toBe(false);
    });
  });

  describe('deleteByModel', () => {
    it('should delete all entries for a model', async () => {
      const modelKey2 = 'local::other-model';

      await repo.set(testContentHash1, testModelKey, testEmbedding1, testDimensions);
      await repo.set(testContentHash2, testModelKey, testEmbedding2, testDimensions);
      await repo.set(testContentHash1, modelKey2, testEmbedding1, testDimensions);

      const deleted = await repo.deleteByModel(testModelKey);

      expect(deleted).toBe(2);

      // Verify deletion
      const result1 = await repo.get(testContentHash1, testModelKey);
      const result2 = await repo.get(testContentHash2, testModelKey);
      const result3 = await repo.get(testContentHash1, modelKey2);

      expect(result1.hit).toBe(false);
      expect(result2.hit).toBe(false);
      expect(result3.hit).toBe(true); // Different model, should still exist
    });
  });

  describe('evictOldest', () => {
    it('should evict oldest entries by accessedAt', async () => {
      // Create entries with different access times
      await repo.set('hash1', testModelKey, testEmbedding1, testDimensions);
      await new Promise((resolve) => setTimeout(resolve, 50));

      await repo.set('hash2', testModelKey, testEmbedding1, testDimensions);
      await new Promise((resolve) => setTimeout(resolve, 50));

      await repo.set('hash3', testModelKey, testEmbedding1, testDimensions);

      // Evict the 2 oldest
      const evicted = await repo.evictOldest(2);

      expect(evicted).toBe(2);

      // Only hash3 should remain
      const result1 = await repo.get('hash1', testModelKey);
      const result2 = await repo.get('hash2', testModelKey);
      const result3 = await repo.get('hash3', testModelKey);

      expect(result1.hit).toBe(false);
      expect(result2.hit).toBe(false);
      expect(result3.hit).toBe(true);
    });

    it('should handle empty cache', async () => {
      const evicted = await repo.evictOldest(10);

      expect(evicted).toBe(0);
    });

    it('should evict all when count exceeds cache size', async () => {
      await repo.set('hash1', testModelKey, testEmbedding1, testDimensions);
      await repo.set('hash2', testModelKey, testEmbedding2, testDimensions);

      const evicted = await repo.evictOldest(100);

      expect(evicted).toBe(2);

      const stats = await repo.getStats();
      expect(stats.totalEntries).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', async () => {
      await repo.set(testContentHash1, testModelKey, testEmbedding1, testDimensions);
      await repo.set(testContentHash2, testModelKey, testEmbedding2, testDimensions);

      // Trigger some cache hits
      await repo.get(testContentHash1, testModelKey);
      await repo.get(testContentHash1, testModelKey);

      // Wait for access updates
      await new Promise((resolve) => setTimeout(resolve, 150));

      const stats = await repo.getStats();

      expect(stats.totalEntries).toBe(2);
      expect(stats.totalHits).toBeGreaterThanOrEqual(2); // At least 2 from initial inserts
      expect(stats.oldestAccessedAt).toBeInstanceOf(Date);
      expect(stats.newestAccessedAt).toBeInstanceOf(Date);
    });

    it('should return zeroes for empty cache', async () => {
      const stats = await repo.getStats();

      expect(stats.totalEntries).toBe(0);
      expect(stats.totalHits).toBe(0);
      expect(stats.oldestAccessedAt).toBeNull();
      expect(stats.newestAccessedAt).toBeNull();
    });
  });

  describe('content-level deduplication scenario', () => {
    it('should cache embeddings by content, not by chunk', async () => {
      // Scenario: Same content appears in multiple chunks
      const _sharedContent = 'MIT License\n\nPermission is hereby granted...';
      const contentHash = 'license-content-hash'; // Same hash for identical content

      // First chunk requests embedding
      const result1 = await repo.get(contentHash, testModelKey);
      expect(result1.hit).toBe(false);

      // Generate and cache embedding
      await repo.set(contentHash, testModelKey, testEmbedding1, testDimensions);

      // Second chunk with same content should hit cache
      const result2 = await repo.get(contentHash, testModelKey);
      expect(result2.hit).toBe(true);

      // Third chunk with same content should also hit
      const result3 = await repo.get(contentHash, testModelKey);
      expect(result3.hit).toBe(true);

      // Wait for access updates
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Access count should reflect reuse
      const stats = await repo.getStats();
      expect(stats.totalEntries).toBe(1); // Only one entry for shared content
      expect(stats.totalHits).toBeGreaterThanOrEqual(1);
    });

    it('should store different embeddings for different models', async () => {
      const contentHash = 'shared-content-hash';
      const model1 = 'local::all-MiniLM-L6-v2';
      const model2 = 'openai::text-embedding-3-small';
      const embedding1 = [0.1, 0.2, 0.3, 0.4];
      const embedding2 = [0.9, 0.8, 0.7, 0.6];

      await repo.set(contentHash, model1, embedding1, testDimensions);
      await repo.set(contentHash, model2, embedding2, testDimensions);

      const result1 = await repo.get(contentHash, model1);
      const result2 = await repo.get(contentHash, model2);

      expect(result1.hit).toBe(true);
      expect(result2.hit).toBe(true);

      if (result1.hit && result2.hit) {
        // Different embeddings for different models
        expect(result1.entry.embedding[0]).toBeCloseTo(0.1, 5);
        expect(result2.entry.embedding[0]).toBeCloseTo(0.9, 5);
      }

      const stats = await repo.getStats();
      expect(stats.totalEntries).toBe(2); // Two entries: same content, different models
    });
  });
});

// BST-989 Pair C promotion parity: the Drizzle variant must carry the raw
// repo's newer semantics before the factory can construct it.
describe('DrizzleEmbeddingCacheRepository promotion parity (BST-989)', () => {
  it('tracks fire-and-forget access-time updates and flushes them', async () => {
    const db = await createMigratedTestDb();
    try {
      const repo = new DrizzleEmbeddingCacheRepository(drizzle(db as never));
      await repo.set('hash-flush', 'model-a', [0.1, 0.2, 0.3], 3);
      const result = await repo.get('hash-flush', 'model-a');
      expect(result.hit).toBe(true);
      // The access-time write is fire-and-forget; flush must await it so a
      // worker shutdown cannot lose the LRU bump (raw-repo semantics).
      await repo.flushPendingAccessTimeUpdates();
      const stats = await repo.getStats();
      // 1 from the insert default + 1 from the flushed access-time bump — the
      // exact value is what proves the flush landed (review #2166: >=1 was
      // satisfied by the insert default alone).
      expect(stats.totalHits).toBe(2);
    } finally {
      await db.close();
    }
  });

  it('evicts oldest entries in a single atomic statement', async () => {
    const db = await createMigratedTestDb();
    try {
      const queries: string[] = [];
      const real = db as unknown as {
        exec: (...a: unknown[]) => unknown;
        query: (...a: unknown[]) => unknown;
        transaction: (...a: unknown[]) => unknown;
      };
      const countingHandle = {
        exec: (...args: unknown[]) => real.exec(...args),
        query: (...args: unknown[]) => {
          queries.push(String(args[0]));
          return real.query(...args);
        },
        transaction: (...args: unknown[]) => real.transaction(...args),
      };
      const repo = new DrizzleEmbeddingCacheRepository(drizzle(countingHandle as never) as never);
      await repo.setBatch([
        { contentHash: 'old', dimensions: 3, embedding: [1, 2, 3], modelKey: 'model-a' },
        { contentHash: 'new', dimensions: 3, embedding: [4, 5, 6], modelKey: 'model-a' },
      ]);
      queries.length = 0;
      const evicted = await repo.evictOldest(1);
      expect(evicted).toBe(1);
      // Selection AND deletion in ONE statement (raw-repo parity, review
      // #2166 round 3): two awaits opened a window where a concurrent lookup
      // could bump a selected victim's accessed_at and still lose it.
      expect(queries).toHaveLength(1);
      expect(queries[0]).toContain('WITH oldest AS');
      expect(queries[0]).toContain('DELETE FROM');
    } finally {
      await db.close();
    }
  });

  it('rejects invalid dimensions and non-finite values with named errors', async () => {
    const db = await createMigratedTestDb();
    try {
      const repo = new DrizzleEmbeddingCacheRepository(drizzle(db as never));
      // Raw-repo parity: these previously reached pgvector and surfaced as
      // driver-level errors instead of named repository errors.
      await expect(repo.set('h', 'model-a', [], 0)).rejects.toThrow('has invalid dimensions');
      await expect(repo.set('h', 'model-a', [1, 2], 2.5)).rejects.toThrow('has invalid dimensions');
      await expect(repo.set('h', 'model-a', [1, Number.NaN, 3], 3)).rejects.toThrow(
        'contains a non-finite value'
      );
      await expect(
        repo.setBatch([
          {
            contentHash: 'h2',
            dimensions: 3,
            embedding: [1, Number.POSITIVE_INFINITY, 3],
            modelKey: 'model-a',
          },
        ])
      ).rejects.toThrow('contains a non-finite value');
    } finally {
      await db.close();
    }
  });

  it('tracks and flushes the getBatch access-time update path too', async () => {
    const db = await createMigratedTestDb();
    try {
      const repo = new DrizzleEmbeddingCacheRepository(drizzle(db as never));
      await repo.setBatch([
        { contentHash: 'batch-1', dimensions: 3, embedding: [1, 2, 3], modelKey: 'model-a' },
        { contentHash: 'batch-2', dimensions: 3, embedding: [4, 5, 6], modelKey: 'model-a' },
      ]);
      const hits = await repo.getBatch([
        { contentHash: 'batch-1', modelKey: 'model-a' },
        { contentHash: 'batch-2', modelKey: 'model-a' },
      ]);
      expect(hits.size).toBe(2);
      await repo.flushPendingAccessTimeUpdates();
      const stats = await repo.getStats();
      // 2 insert defaults + 2 flushed batch access-time bumps.
      expect(stats.totalHits).toBe(4);
    } finally {
      await db.close();
    }
  });

  it('de-duplicates a batch on (contentHash, modelKey) so a duplicate key does not throw', async () => {
    const db = await createMigratedTestDb();
    try {
      const repo = new DrizzleEmbeddingCacheRepository(drizzle(db as never));
      // Byte-identical content under two roots in one mixed-root batch —
      // without write-side de-dup the multi-row ON CONFLICT INSERT fails
      // with SQLSTATE 21000 (raw-repo parity; see _shared.ts).
      const stored = await repo.setBatch([
        { contentHash: 'shared', dimensions: 3, embedding: [1, 2, 3], modelKey: 'model-a' },
        { contentHash: 'shared', dimensions: 3, embedding: [4, 5, 6], modelKey: 'model-a' },
      ]);
      expect(stored).toBe(1);
      // First occurrence wins, matching the raw repository's semantics.
      const hit = await repo.get('shared', 'model-a');
      expect(hit.hit).toBe(true);
      if (hit.hit) {
        expect(hit.entry.embedding[0]).toBeCloseTo(1, 5);
      }
      await repo.flushPendingAccessTimeUpdates();
    } finally {
      await db.close();
    }
  });

  it('honors a configurable maxEntries in evictIfNeeded', async () => {
    const db = await createMigratedTestDb();
    try {
      const repo = new DrizzleEmbeddingCacheRepository(drizzle(db as never), { maxEntries: 2 });
      for (const n of [1, 2, 3]) {
        await repo.set(`hash-${n}`, 'model-a', [n, n, n], 3);
      }
      const verdict = await repo.evictIfNeeded({ dryRun: true });
      expect(verdict.needed).toBe(true);
      expect(verdict.totalEntries).toBe(3);
    } finally {
      await db.close();
    }
  });
});

// The promoted factory (BST-989 Pair C): a capability dispatch. Every
// IN-PROCESS execution surface (plain PGlite, scheduled/priority handles —
// they all carry callback `transaction`) gets the Drizzle variant, wrapped —
// never unwrapped — so a priority/scheduling proxy stays in the query path.
// The Electron-style query-only IPC handle keeps the raw implementation:
// drizzle's pglite driver ships parser FUNCTIONS in `client.query`'s third
// argument, which cannot survive structured clone across the IPC bridge.
describe('createEmbeddingCacheRepository promotion (BST-989)', () => {
  it('builds a working Drizzle repo over a plain PGlite client', async () => {
    const { createEmbeddingCacheRepository } = await import(
      '../src/repositories/embedding-cache-repository.js'
    );
    const db = await createMigratedTestDb();
    try {
      const repo = createEmbeddingCacheRepository(db as never);
      expect(repo).toBeInstanceOf(DrizzleEmbeddingCacheRepository);
      await repo.set('hash-factory', 'model-a', [1, 2, 3], 3);
      const hit = await repo.get('hash-factory', 'model-a');
      expect(hit.hit).toBe(true);
      await repo.flushPendingAccessTimeUpdates();
    } finally {
      await db.close();
    }
  });

  it('keeps a scheduling proxy in the query path (wrap, never unwrap)', async () => {
    const { createEmbeddingCacheRepository } = await import(
      '../src/repositories/embedding-cache-repository.js'
    );
    const db = await createMigratedTestDb();
    try {
      let proxiedQueries = 0;
      // A plain pass-through client with its own query/exec/transaction
      // wrappers delegating to the real client. This pins that the factory
      // never reaches around a wrapping surface for `.raw`; the full
      // production proxy stack (real scheduler + priority handle) is
      // exercised by the QoS test below.
      const real = db as unknown as {
        query: (...a: unknown[]) => unknown;
        exec: (...a: unknown[]) => unknown;
        transaction: (...a: unknown[]) => unknown;
      };
      const proxyHandle = {
        exec: (...args: unknown[]) => real.exec(...args),
        query: (...args: unknown[]) => {
          proxiedQueries += 1;
          return real.query(...args);
        },
        transaction: (...args: unknown[]) => real.transaction(...args),
      };
      const repo = createEmbeddingCacheRepository(proxyHandle as never);
      await repo.set('hash-proxy', 'model-a', [1, 2, 3], 3);
      const hit = await repo.get('hash-proxy', 'model-a');
      // Without this flush, close() below runs while get()'s fire-and-forget
      // access-time UPDATE is still in flight and PGlite wedges its WASM
      // event loop permanently (observed: even vitest's testTimeout never
      // fires). The flush IS the ported shutdown-safety semantics under test.
      await repo.flushPendingAccessTimeUpdates();
      expect(hit.hit).toBe(true);
      // The proxied query surface must have carried the traffic — unwrapping
      // to .raw would leave this at zero and silently bypass scheduling.
      expect(proxiedQueries).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });

  it('keeps background QoS through the real scheduler + priority-handle stack', async () => {
    const { createEmbeddingCacheRepository } = await import(
      '../src/repositories/embedding-cache-repository.js'
    );
    const { createDatabaseWorkScheduler, createScheduledDbHandle, createPriorityDbHandle } =
      await import('../src/database-work-scheduler.js');
    const { createDbHandle } = await import('../src/db-handle.js');
    const db = await createMigratedTestDb();
    try {
      // The exact production web stack (embedding-runtime-controller):
      // PGlite → scheduled handle → DbProvider's exposed DbHandle →
      // createPriorityDbHandle(…, 'background') → this factory. Drizzle's
      // native per-query config occupies the 3rd query argument, pushing the
      // scheduler work options into a 4th — which the DbHandle wrapper's
      // fixed arity used to DROP, silently running background embedding-cache
      // traffic at foreground priority (review #2166 P1).
      const scheduler = createDatabaseWorkScheduler();
      const scheduled = createScheduledDbHandle(db as never, scheduler, 'foreground');
      const exposed = createDbHandle(scheduled as never);
      const background = createPriorityDbHandle(exposed as never, 'background');
      const repo = createEmbeddingCacheRepository(background as never);
      await repo.set('hash-qos', 'model-a', [1, 2, 3], 3);
      const hit = await repo.get('hash-qos', 'model-a');
      expect(hit.hit).toBe(true);
      await repo.flushPendingAccessTimeUpdates();
      const stats = scheduler.getSnapshot().priorityStats;
      expect(stats.background.started).toBeGreaterThan(0);
      // Every repo query must have carried the background tag — foreground
      // work on this scheduler would mean the priority was dropped en route.
      expect(stats.foreground.started).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('dispatches a query-only IPC-style handle to the boundary-hardened raw class', async () => {
    const { createEmbeddingCacheRepository, EmbeddingCacheRepository } = await import(
      '../src/repositories/embedding-cache-repository.js'
    );
    const db = await createMigratedTestDb();
    try {
      const real = db as unknown as {
        query: (...a: unknown[]) => unknown;
      };
      // The desktop preload bridge shape: query only — no callback
      // `transaction` (it exposes statement-list runTransaction instead,
      // #1141/#1145) and no .raw. Must NOT be given the Drizzle variant.
      const ipcHandle = {
        query: (sql: string, params?: unknown[]) => real.query(sql, params),
      };
      expect('transaction' in ipcHandle).toBe(false);
      const repo = createEmbeddingCacheRepository(ipcHandle as never);
      expect(repo).toBeInstanceOf(EmbeddingCacheRepository);
      expect(repo).not.toBeInstanceOf(DrizzleEmbeddingCacheRepository);

      // The marker is POSITIVE (statement-list runTransaction identifies the
      // bridge), not the absence of `transaction`: DesktopDatabaseBridge's
      // optional callback-transaction member invites a future preload to add
      // one, and that must still not flip desktop into drizzle-over-IPC
      // (review #2166). Driven through the REAL createDbHandle because it
      // unconditionally installs `.raw` (= the bridge executor) — a marker
      // guard on the direct branch alone would be bypassed by extractPGlite
      // unwrapping that `.raw` (review #2166 round 3).
      const { createDbHandle } = await import('../src/db-handle.js');
      const futureBridgeExecutor = {
        exec: async (sql: string) => (db as unknown as { exec: (s: string) => unknown }).exec(sql),
        query: async (sql: string, params?: unknown[]) => real.query(sql, params),
        runTransaction: async () => ({ rows: [] }),
        transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(futureBridgeExecutor),
      };
      const futureHandle = createDbHandle(futureBridgeExecutor as never);
      expect((futureHandle as { raw?: unknown }).raw).toBe(futureBridgeExecutor);
      const futureRepo = createEmbeddingCacheRepository(futureHandle as never);
      expect(futureRepo).toBeInstanceOf(EmbeddingCacheRepository);
      expect(futureRepo).not.toBeInstanceOf(DrizzleEmbeddingCacheRepository);
    } finally {
      await db.close();
    }
  });

  it('throws loudly on a handle with no execution surface', async () => {
    const { createEmbeddingCacheRepository } = await import(
      '../src/repositories/embedding-cache-repository.js'
    );
    expect(() => createEmbeddingCacheRepository({} as never)).toThrow('PGlite-compatible handle');
  });
});
