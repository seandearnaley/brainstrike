/**
 * Drizzle EmbeddingCacheRepository Tests (BST-170)
 *
 * Tests the Drizzle-based EmbeddingCacheRepository implementation.
 */

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { DrizzleEmbeddingCacheRepository } from '../src/repositories/drizzle/embedding-cache-repository.js';
import * as schema from '../src/schema/index.js';

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
    client = new PGlite({
      extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector },
    });

    const migrationResult = await runMigrations(client);
    if (!migrationResult.success) {
      throw new Error(`Migrations failed: ${migrationResult.error}`);
    }
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
