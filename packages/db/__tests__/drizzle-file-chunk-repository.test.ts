/**
 * Drizzle FileChunk Repository Tests
 *
 * Tests the Drizzle-based FileChunkRepository implementation.
 */

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { DrizzleEmbeddingSetsRepository } from '../src/repositories/drizzle/embedding-sets-repository.js';
import {
  DrizzleFileChunkRepository,
  MAX_SEARCH_RESULT_LIMIT,
} from '../src/repositories/drizzle/file-chunk-repository.js';
import { DrizzleFileRecordRepository } from '../src/repositories/drizzle/file-record-repository.js';
import * as schema from '../src/schema/index.js';

describe('DrizzleFileChunkRepository', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  let repository: DrizzleFileChunkRepository;
  let fileRecordRepository: DrizzleFileRecordRepository;
  let embeddingSetsRepository: DrizzleEmbeddingSetsRepository;

  // Test data
  const testFileRecordId = '00000000-0000-0000-0000-000000000001';
  let testEmbeddingSetId: string;

  beforeEach(async () => {
    client = new PGlite({
      extensions: { vector },
    });

    // Run migrations to set up schema
    await runMigrations(client);

    // Create Drizzle instance
    db = drizzle(client, { schema });
    repository = new DrizzleFileChunkRepository(db);
    fileRecordRepository = new DrizzleFileRecordRepository(db);
    embeddingSetsRepository = new DrizzleEmbeddingSetsRepository(db);

    // Create a test file record
    const now = new Date().toISOString();
    await fileRecordRepository.create({
      id: testFileRecordId,
      name: 'test.ts',
      path: '/src/test.ts',
      size: 1024,
      createdAt: now,
      updatedAt: now,
    });

    // Create a test embedding set and capture its ID
    const embeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'test-model',
      'test-model-id',
      3,
      'cosine',
      { name: 'Test Set' }
    );
    testEmbeddingSetId = embeddingSet.id;
  });

  afterEach(async () => {
    await client.close();
  });

  describe('insert and findById', () => {
    it('should insert a chunk and find it by id', async () => {
      const now = new Date().toISOString();
      const chunk = {
        id: '00000000-0000-0000-0000-000000000010',
        fileRecordId: testFileRecordId,
        chunkIndex: 0,
        content: 'const hello = "world";',
        contentHash: 'hash123',
        tokenCount: 5,
        chunkType: 'code' as const,
        chunkSize: 22,
        createdAt: now,
        updatedAt: now,
      };

      const inserted = await repository.insert(chunk);
      expect(inserted.id).toBe(chunk.id);
      expect(inserted.content).toBe(chunk.content);

      const found = await repository.findById(chunk.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(chunk.id);
      expect(found?.content).toBe(chunk.content);
      expect(found?.chunkIndex).toBe(0);
    });

    it('should return null for non-existent id', async () => {
      const found = await repository.findById('00000000-0000-0000-0000-000000000000');
      expect(found).toBeNull();
    });
  });

  describe('findByFileRecordId', () => {
    it('should find all chunks for a file record ordered by index', async () => {
      const now = new Date().toISOString();

      // Insert chunks out of order
      await repository.insert({
        id: '00000000-0000-0000-0000-000000000012',
        fileRecordId: testFileRecordId,
        chunkIndex: 2,
        content: 'chunk 2',
        createdAt: now,
        updatedAt: now,
      });

      await repository.insert({
        id: '00000000-0000-0000-0000-000000000010',
        fileRecordId: testFileRecordId,
        chunkIndex: 0,
        content: 'chunk 0',
        createdAt: now,
        updatedAt: now,
      });

      await repository.insert({
        id: '00000000-0000-0000-0000-000000000011',
        fileRecordId: testFileRecordId,
        chunkIndex: 1,
        content: 'chunk 1',
        createdAt: now,
        updatedAt: now,
      });

      const chunks = await repository.findByFileRecordId(testFileRecordId);
      expect(chunks).toHaveLength(3);
      expect(chunks[0]?.chunkIndex).toBe(0);
      expect(chunks[1]?.chunkIndex).toBe(1);
      expect(chunks[2]?.chunkIndex).toBe(2);
    });
  });

  describe('insertMany', () => {
    it('should insert multiple chunks', async () => {
      const now = new Date().toISOString();
      const chunks = [
        {
          id: '00000000-0000-0000-0000-000000000010',
          fileRecordId: testFileRecordId,
          chunkIndex: 0,
          content: 'chunk 0',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: '00000000-0000-0000-0000-000000000011',
          fileRecordId: testFileRecordId,
          chunkIndex: 1,
          content: 'chunk 1',
          createdAt: now,
          updatedAt: now,
        },
      ];

      const inserted = await repository.insertMany(chunks);
      expect(inserted).toHaveLength(2);

      const all = await repository.findAll();
      expect(all).toHaveLength(2);
    });

    it('should return empty array for empty input', async () => {
      const inserted = await repository.insertMany([]);
      expect(inserted).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('should update chunk fields', async () => {
      const now = new Date().toISOString();
      await repository.insert({
        id: '00000000-0000-0000-0000-000000000010',
        fileRecordId: testFileRecordId,
        chunkIndex: 0,
        content: 'original content',
        createdAt: now,
        updatedAt: now,
      });

      const updated = await repository.update({
        id: '00000000-0000-0000-0000-000000000010',
        content: 'updated content',
        tokenCount: 10,
        updatedAt: new Date().toISOString(),
      });

      expect(updated?.content).toBe('updated content');
      expect(updated?.tokenCount).toBe(10);
    });

    it('should update embedding with timestamp', async () => {
      const now = new Date().toISOString();
      await repository.insert({
        id: '00000000-0000-0000-0000-000000000010',
        fileRecordId: testFileRecordId,
        chunkIndex: 0,
        content: 'content',
        createdAt: now,
        updatedAt: now,
      });

      const embedding = [0.1, 0.2, 0.3];
      const updated = await repository.update({
        id: '00000000-0000-0000-0000-000000000010',
        embedding,
        embeddingSetId: testEmbeddingSetId,
        updatedAt: new Date().toISOString(),
      });

      expect(updated?.embedding).toEqual(embedding);
      expect(updated?.embeddingSetId).toBe(testEmbeddingSetId);
      expect(updated?.embeddingUpdatedAt).toBeDefined();
    });
  });

  describe('delete', () => {
    it('should delete a chunk', async () => {
      const now = new Date().toISOString();
      await repository.insert({
        id: '00000000-0000-0000-0000-000000000010',
        fileRecordId: testFileRecordId,
        chunkIndex: 0,
        content: 'to delete',
        createdAt: now,
        updatedAt: now,
      });

      const deleted = await repository.delete('00000000-0000-0000-0000-000000000010');
      expect(deleted).toBe(true);

      const found = await repository.findById('00000000-0000-0000-0000-000000000010');
      expect(found).toBeNull();
    });

    it('should return false for non-existent chunk', async () => {
      const deleted = await repository.delete('00000000-0000-0000-0000-000000000000');
      expect(deleted).toBe(false);
    });
  });

  describe('deleteByFileRecordId', () => {
    it('should delete all chunks for a file record', async () => {
      const now = new Date().toISOString();
      await repository.insertMany([
        {
          id: '00000000-0000-0000-0000-000000000010',
          fileRecordId: testFileRecordId,
          chunkIndex: 0,
          content: 'chunk 0',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: '00000000-0000-0000-0000-000000000011',
          fileRecordId: testFileRecordId,
          chunkIndex: 1,
          content: 'chunk 1',
          createdAt: now,
          updatedAt: now,
        },
      ]);

      const deletedCount = await repository.deleteByFileRecordId(testFileRecordId);
      expect(deletedCount).toBe(2);

      const remaining = await repository.findByFileRecordId(testFileRecordId);
      expect(remaining).toHaveLength(0);
    });
  });

  describe('searchSimilar', () => {
    it('should throw error when embeddingSetId is not provided', async () => {
      await expect(repository.searchSimilar([0.1, 0.2, 0.3])).rejects.toThrow(
        'searchSimilar requires embeddingSetId'
      );
    });

    it('should throw error for dimension mismatch', async () => {
      await expect(
        repository.searchSimilar([0.1, 0.2, 0.3, 0.4], { embeddingSetId: testEmbeddingSetId })
      ).rejects.toThrow('dimension mismatch');
    });

    it('accepts the product result-limit ceiling and rejects above it', async () => {
      // The UI free-input ceiling (RESULT_LIMIT_MAX) clamps to this value and
      // hybrid sizes its source pools up to it, so the web repository must accept
      // exactly the ceiling — otherwise limits 1001–2000 throw only on web. Pin
      // the cap so it can't silently drop below the product ceiling again.
      await expect(
        repository.searchSimilar([1.0, 0.0, 0.0], {
          embeddingSetId: testEmbeddingSetId,
          limit: MAX_SEARCH_RESULT_LIMIT,
          threshold: 0,
        })
      ).resolves.toBeDefined();

      await expect(
        repository.searchSimilar([1.0, 0.0, 0.0], {
          embeddingSetId: testEmbeddingSetId,
          limit: MAX_SEARCH_RESULT_LIMIT + 1,
          threshold: 0,
        })
      ).rejects.toThrow(/exceeds maximum allowed/);
    });

    it('should return similar chunks ordered by similarity', async () => {
      const now = new Date().toISOString();

      // Insert chunks with embeddings
      await repository.insert({
        id: '00000000-0000-0000-0000-000000000010',
        fileRecordId: testFileRecordId,
        chunkIndex: 0,
        content: 'similar content',
        embedding: [0.9, 0.1, 0.0],
        embeddingSetId: testEmbeddingSetId,
        createdAt: now,
        updatedAt: now,
      });

      await repository.insert({
        id: '00000000-0000-0000-0000-000000000011',
        fileRecordId: testFileRecordId,
        chunkIndex: 1,
        content: 'different content',
        embedding: [0.0, 0.1, 0.9],
        embeddingSetId: testEmbeddingSetId,
        createdAt: now,
        updatedAt: now,
      });

      const results = await repository.searchSimilar([1.0, 0.0, 0.0], {
        embeddingSetId: testEmbeddingSetId,
        limit: 10,
        threshold: 0.0,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.chunk.id).toBe('00000000-0000-0000-0000-000000000010');
      expect(results[0]?.similarity).toBeGreaterThan(results[1]?.similarity ?? 0);
    });

    it('should scope results by file path allowlist and selection snapshot', async () => {
      const now = new Date().toISOString();
      const secondFileRecordId = '00000000-0000-0000-0000-000000000002';
      await fileRecordRepository.create({
        id: secondFileRecordId,
        name: 'other.ts',
        path: '/src/other.ts',
        size: 2048,
        createdAt: now,
        updatedAt: now,
      });

      await repository.insert({
        id: '00000000-0000-0000-0000-000000000020',
        fileRecordId: testFileRecordId,
        chunkIndex: 0,
        content: 'alpha chunk',
        embedding: [0.9, 0.1, 0.0],
        embeddingSetId: testEmbeddingSetId,
        createdAt: now,
        updatedAt: now,
      });

      await repository.insert({
        id: '00000000-0000-0000-0000-000000000021',
        fileRecordId: secondFileRecordId,
        chunkIndex: 0,
        content: 'beta chunk',
        embedding: [0.8, 0.2, 0.0],
        embeddingSetId: testEmbeddingSetId,
        createdAt: now,
        updatedAt: now,
      });

      const allowlisted = await repository.searchSimilar([1.0, 0.0, 0.0], {
        embeddingSetId: testEmbeddingSetId,
        limit: 10,
        threshold: 0,
        filePaths: ['/src/test.ts'],
      });
      expect(allowlisted.map((r) => r.chunk.id)).toEqual(['00000000-0000-0000-0000-000000000020']);

      const snapshotId = '00000000-0000-0000-0000-000000000201';
      await client.query('INSERT INTO selection_snapshots (id, created_at) VALUES ($1, $2)', [
        snapshotId,
        now,
      ]);
      await client.query(
        'INSERT INTO selection_snapshot_files (snapshot_id, file_path) VALUES ($1, $2)',
        [snapshotId, '/src/other.ts']
      );

      const snapshotScoped = await repository.searchSimilar([1.0, 0.0, 0.0], {
        embeddingSetId: testEmbeddingSetId,
        limit: 10,
        threshold: 0,
        selectionSnapshotId: snapshotId,
      });
      expect(snapshotScoped.map((r) => r.chunk.id)).toEqual([
        '00000000-0000-0000-0000-000000000021',
      ]);
    });
  });

  describe('getStats', () => {
    it('should return statistics about chunks', async () => {
      const now = new Date().toISOString();

      await repository.insert({
        id: '00000000-0000-0000-0000-000000000010',
        fileRecordId: testFileRecordId,
        chunkIndex: 0,
        content: 'code chunk',
        chunkType: 'code',
        tokenCount: 10,
        embedding: [0.1, 0.2, 0.3],
        embeddingSetId: testEmbeddingSetId,
        createdAt: now,
        updatedAt: now,
      });

      await repository.insert({
        id: '00000000-0000-0000-0000-000000000011',
        fileRecordId: testFileRecordId,
        chunkIndex: 1,
        content: 'text chunk',
        chunkType: 'text',
        tokenCount: 20,
        createdAt: now,
        updatedAt: now,
      });

      const stats = await repository.getStats();
      expect(stats.totalChunks).toBe(2);
      expect(stats.chunksWithEmbeddings).toBeGreaterThanOrEqual(1);
      expect(stats.chunkTypeDistribution).toBeDefined();
    });
  });

  describe('getCoverageForSet', () => {
    it('should return coverage for an embedding set', async () => {
      const now = new Date().toISOString();

      await repository.insert({
        id: '00000000-0000-0000-0000-000000000010',
        fileRecordId: testFileRecordId,
        chunkIndex: 0,
        content: 'with embedding',
        embedding: [0.1, 0.2, 0.3],
        embeddingSetId: testEmbeddingSetId,
        createdAt: now,
        updatedAt: now,
      });

      await repository.insert({
        id: '00000000-0000-0000-0000-000000000011',
        fileRecordId: testFileRecordId,
        chunkIndex: 1,
        content: 'without embedding',
        createdAt: now,
        updatedAt: now,
      });

      const coverage = await repository.getCoverageForSet(testEmbeddingSetId);
      expect(coverage.totalChunks).toBe(2);
      expect(coverage.chunksWithEmbeddingsForSet).toBe(1);
    });

    it('should throw error when embeddingSetId is not provided', async () => {
      await expect(repository.getCoverageForSet('')).rejects.toThrow('embeddingSetId is required');
    });
  });

  describe('clearAll', () => {
    it('should clear all chunks and return count', async () => {
      const now = new Date().toISOString();

      await repository.insertMany([
        {
          id: '00000000-0000-0000-0000-000000000010',
          fileRecordId: testFileRecordId,
          chunkIndex: 0,
          content: 'chunk 0',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: '00000000-0000-0000-0000-000000000011',
          fileRecordId: testFileRecordId,
          chunkIndex: 1,
          content: 'chunk 1',
          createdAt: now,
          updatedAt: now,
        },
      ]);

      const cleared = await repository.clearAll();
      expect(cleared).toBe(2);

      const all = await repository.findAll();
      expect(all).toHaveLength(0);
    });
  });

  describe('vector validation security', () => {
    it('should reject NaN values in searchSimilar query embedding', async () => {
      await expect(
        repository.searchSimilar([0.1, Number.NaN, 0.3], { embeddingSetId: testEmbeddingSetId })
      ).rejects.toThrow('Invalid');
    });

    it('should reject Infinity values in searchSimilar query embedding', async () => {
      await expect(
        repository.searchSimilar([0.1, Number.POSITIVE_INFINITY, 0.3], {
          embeddingSetId: testEmbeddingSetId,
        })
      ).rejects.toThrow('Invalid');
    });

    it('should reject -Infinity values in searchSimilar query embedding', async () => {
      await expect(
        repository.searchSimilar([0.1, Number.NEGATIVE_INFINITY, 0.3], {
          embeddingSetId: testEmbeddingSetId,
        })
      ).rejects.toThrow('Invalid');
    });

    it('should reject empty array in searchSimilar query embedding', async () => {
      await expect(
        repository.searchSimilar([], { embeddingSetId: testEmbeddingSetId })
      ).rejects.toThrow();
    });

    it('should reject NaN values when inserting chunk with embedding', async () => {
      const now = new Date().toISOString();
      await expect(
        repository.insert({
          id: '00000000-0000-0000-0000-000000000099',
          fileRecordId: testFileRecordId,
          chunkIndex: 0,
          content: 'test',
          embedding: [0.1, Number.NaN, 0.3],
          embeddingSetId: testEmbeddingSetId,
          createdAt: now,
          updatedAt: now,
        })
      ).rejects.toThrow('Invalid');
    });

    it('should reject Infinity values when inserting chunk with embedding', async () => {
      const now = new Date().toISOString();
      await expect(
        repository.insert({
          id: '00000000-0000-0000-0000-000000000099',
          fileRecordId: testFileRecordId,
          chunkIndex: 0,
          content: 'test',
          embedding: [0.1, Number.POSITIVE_INFINITY, 0.3],
          embeddingSetId: testEmbeddingSetId,
          createdAt: now,
          updatedAt: now,
        })
      ).rejects.toThrow('Invalid');
    });

    it('should reject NaN values when updating chunk embedding', async () => {
      const now = new Date().toISOString();
      await repository.insert({
        id: '00000000-0000-0000-0000-000000000098',
        fileRecordId: testFileRecordId,
        chunkIndex: 0,
        content: 'test',
        createdAt: now,
        updatedAt: now,
      });

      await expect(
        repository.update({
          id: '00000000-0000-0000-0000-000000000098',
          embedding: [0.1, Number.NaN, 0.3],
          embeddingSetId: testEmbeddingSetId,
          updatedAt: new Date().toISOString(),
        })
      ).rejects.toThrow('Invalid');
    });
  });
});
