/**
 * Drizzle FileChunk Repository Tests
 *
 * Tests the Drizzle-based FileChunkRepository implementation.
 */

import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileChunkInsert } from '../src/models/file-chunk.js';
import { DrizzleEmbeddingSetsRepository } from '../src/repositories/drizzle/embedding-sets-repository.js';
import {
  DrizzleFileChunkRepository,
  MAX_SEARCH_RESULT_LIMIT,
} from '../src/repositories/drizzle/file-chunk-repository.js';
import { DrizzleFileRecordRepository } from '../src/repositories/drizzle/file-record-repository.js';
import * as schema from '../src/schema/index.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

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
    client = await createMigratedTestDb();

    // Create Drizzle instance
    db = drizzle(client, { schema });
    repository = new DrizzleFileChunkRepository(db);
    fileRecordRepository = new DrizzleFileRecordRepository(db);
    embeddingSetsRepository = new DrizzleEmbeddingSetsRepository(db);

    // Create a test file record
    const now = new Date().toISOString();
    await fileRecordRepository.create({
      createdAt: now,
      id: testFileRecordId,
      name: 'test.ts',
      path: '/src/test.ts',
      size: 1024,
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
        chunkIndex: 0,
        chunkSize: 22,
        chunkType: 'code' as const,
        content: 'const hello = "world";',
        contentHash: 'hash123',
        createdAt: now,
        fileRecordId: testFileRecordId,
        id: '00000000-0000-0000-0000-000000000010',
        tokenCount: 5,
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

  describe('findGrepCandidates (BST-989 slice 2 parity)', () => {
    const seed = async () => {
      const now = new Date().toISOString();
      await repository.insertMany([
        {
          chunkIndex: 0,
          content: 'function alphaBeta() {}',
          createdAt: now,
          fileRecordId: testFileRecordId,
          id: '00000000-0000-0000-0000-000000000210',
          startLine: 1,
          updatedAt: now,
        },
        {
          chunkIndex: 1,
          content: 'const unrelated = true;',
          createdAt: now,
          fileRecordId: testFileRecordId,
          id: '00000000-0000-0000-0000-000000000211',
          startLine: 10,
          updatedAt: now,
        },
      ]);
    };

    it('matches case-insensitively by default and case-sensitively on request', async () => {
      await seed();
      const insensitive = await repository.findGrepCandidates({
        caseSensitive: false,
        likePattern: 'ALPHABETA',
        limit: 10,
      });
      expect(insensitive.map((candidate) => candidate.chunkId)).toEqual([
        '00000000-0000-0000-0000-000000000210',
      ]);
      expect(insensitive[0]?.filePath).toBeDefined();

      const sensitive = await repository.findGrepCandidates({
        caseSensitive: true,
        likePattern: 'ALPHABETA',
        limit: 10,
      });
      expect(sensitive).toEqual([]);
    });

    it('treats an empty allowlist as nothing allowed', async () => {
      await seed();
      await expect(
        repository.findGrepCandidates({
          caseSensitive: false,
          filePaths: [],
          likePattern: 'alpha',
          limit: 10,
        })
      ).resolves.toEqual([]);
      await expect(
        repository.findGrepCandidates({
          caseSensitive: false,
          likePattern: 'alpha',
          limit: 10,
          rootIds: [],
        })
      ).resolves.toEqual([]);
    });
  });

  describe('insertManyWithTx (BST-989 slice 2 parity)', () => {
    it('upserts within a caller transaction and returns mapped chunks', async () => {
      const now = new Date().toISOString();
      const chunk = {
        chunkIndex: 0,
        content: 'transactional chunk',
        createdAt: now,
        fileRecordId: testFileRecordId,
        id: '00000000-0000-0000-0000-000000000220',
        tokenCount: 3,
        updatedAt: now,
      };

      const results = await client.transaction(async (tx) =>
        repository.insertManyWithTx(
          { query: (sqlText: string, params?: unknown[]) => tx.query(sqlText, params) },
          [chunk]
        )
      );

      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe(chunk.id);
      expect(results[0]?.content).toBe('transactional chunk');

      const found = await repository.findById(chunk.id);
      expect(found?.content).toBe('transactional chunk');
    });

    it('participates in the caller transaction: a rollback discards the writes', async () => {
      const now = new Date().toISOString();
      const chunk = {
        chunkIndex: 0,
        content: 'rolled back chunk',
        createdAt: now,
        fileRecordId: testFileRecordId,
        id: '00000000-0000-0000-0000-000000000221',
        updatedAt: now,
      };

      await expect(
        client.transaction(async (tx) => {
          await repository.insertManyWithTx(
            { query: (sqlText: string, params?: unknown[]) => tx.query(sqlText, params) },
            [chunk]
          );
          throw new Error('force rollback');
        })
      ).rejects.toThrow('force rollback');

      // If the implementation had opened its own connection, the row would
      // have committed independently and survived the caller's rollback.
      await expect(repository.findById(chunk.id)).resolves.toBeNull();
    });
  });

  describe('findByFileRecordId', () => {
    it('should find all chunks for a file record ordered by index', async () => {
      const now = new Date().toISOString();

      // Insert chunks out of order
      await repository.insert({
        chunkIndex: 2,
        content: 'chunk 2',
        createdAt: now,
        fileRecordId: testFileRecordId,
        id: '00000000-0000-0000-0000-000000000012',
        updatedAt: now,
      });

      await repository.insert({
        chunkIndex: 0,
        content: 'chunk 0',
        createdAt: now,
        fileRecordId: testFileRecordId,
        id: '00000000-0000-0000-0000-000000000010',
        updatedAt: now,
      });

      await repository.insert({
        chunkIndex: 1,
        content: 'chunk 1',
        createdAt: now,
        fileRecordId: testFileRecordId,
        id: '00000000-0000-0000-0000-000000000011',
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
          chunkIndex: 0,
          content: 'chunk 0',
          createdAt: now,
          fileRecordId: testFileRecordId,
          id: '00000000-0000-0000-0000-000000000010',
          updatedAt: now,
        },
        {
          chunkIndex: 1,
          content: 'chunk 1',
          createdAt: now,
          fileRecordId: testFileRecordId,
          id: '00000000-0000-0000-0000-000000000011',
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

    it('rejects null bytes in chunk content before batch insert reaches PGlite', async () => {
      const now = new Date().toISOString();

      await expect(
        repository.insertMany([
          {
            chunkIndex: 0,
            content: 'chunk 0',
            createdAt: now,
            fileRecordId: testFileRecordId,
            id: '00000000-0000-0000-0000-000000000010',
            updatedAt: now,
          },
          {
            chunkIndex: 1,
            content: `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`,
            createdAt: now,
            fileRecordId: testFileRecordId,
            id: '00000000-0000-0000-0000-000000000011',
            updatedAt: now,
          },
        ])
      ).rejects.toThrow('File chunk content cannot contain null bytes.');
    });
  });

  describe('update', () => {
    it('should update chunk fields', async () => {
      const now = new Date().toISOString();
      await repository.insert({
        chunkIndex: 0,
        content: 'original content',
        createdAt: now,
        fileRecordId: testFileRecordId,
        id: '00000000-0000-0000-0000-000000000010',
        updatedAt: now,
      });

      const updated = await repository.update({
        content: 'updated content',
        id: '00000000-0000-0000-0000-000000000010',
        tokenCount: 10,
        updatedAt: new Date().toISOString(),
      });

      expect(updated?.content).toBe('updated content');
      expect(updated?.tokenCount).toBe(10);
    });

    it('should update embedding with timestamp', async () => {
      const now = new Date().toISOString();
      await repository.insert({
        chunkIndex: 0,
        content: 'content',
        createdAt: now,
        fileRecordId: testFileRecordId,
        id: '00000000-0000-0000-0000-000000000010',
        updatedAt: now,
      });

      const embedding = [0.1, 0.2, 0.3];
      const updated = await repository.update({
        embedding,
        embeddingSetId: testEmbeddingSetId,
        id: '00000000-0000-0000-0000-000000000010',
        updatedAt: new Date().toISOString(),
      });

      expect(updated?.embedding).toEqual(embedding);
      expect(updated?.embeddingSetId).toBe(testEmbeddingSetId);
      expect(updated?.embeddingUpdatedAt).toBeDefined();
    });

    it('rejects null bytes in chunk content before update reaches PGlite', async () => {
      await expect(
        repository.update({
          content: `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`,
          id: '00000000-0000-0000-0000-000000000010',
          updatedAt: new Date().toISOString(),
        })
      ).rejects.toThrow('File chunk content cannot contain null bytes.');
    });
  });

  describe('delete', () => {
    it('should delete a chunk', async () => {
      const now = new Date().toISOString();
      await repository.insert({
        chunkIndex: 0,
        content: 'to delete',
        createdAt: now,
        fileRecordId: testFileRecordId,
        id: '00000000-0000-0000-0000-000000000010',
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
          chunkIndex: 0,
          content: 'chunk 0',
          createdAt: now,
          fileRecordId: testFileRecordId,
          id: '00000000-0000-0000-0000-000000000010',
          updatedAt: now,
        },
        {
          chunkIndex: 1,
          content: 'chunk 1',
          createdAt: now,
          fileRecordId: testFileRecordId,
          id: '00000000-0000-0000-0000-000000000011',
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
  });

  // Selective narrowed searches must bypass the ANN index via an exact
  // full-precision scan (the partial halfvec HNSW index returns as little as
  // 39.5% recall@10 on ~10%-selective filters at 100k chunks — see
  // docs/binary-quantization-two-stage-benchmark-2026-07-11.md). The web/Drizzle
  // repository routes exactly like FileChunkRepository / ElectronFileChunkRepository:
  // bounded selectivity counts per narrowed search, none for whole-set searches.
  describe('searchSimilar adaptive routing (selective filters)', () => {
    const dim = 3;
    const broadRootId = 'root-broad';
    const narrowRootId = 'root-narrow';
    const queryVector = [1.0, 0.0, 0.0];

    // 40 chunks in root-broad + 5 in root-narrow (45 total in the set):
    //  - root-narrow matched=5 -> total cap ceil(5/0.15)=34 <= 45 -> EXACT
    //  - root-broad matched=40 -> total cap ceil(40/0.15)=267 > 45 -> ANN
    // Cosine similarity to the axis-0 query decreases with the chunk index.
    const seedRoutingCorpus = async (): Promise<void> => {
      const now = new Date().toISOString();
      await client.query(
        `INSERT INTO roots (id, kind, display_name, path, status, created_at)
         VALUES ($1, 'path', $2, $3, 'live', $4), ($5, 'path', $6, $7, 'live', $8)`,
        [broadRootId, 'Broad', '/work/broad', now, narrowRootId, 'Narrow', '/work/narrow', now]
      );
      await client.query(
        `INSERT INTO file_records (id, name, path, root_id, size, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7), ($8, $9, $10, $11, $12, $13, $14)`,
        [
          'f-broad',
          'a.md',
          'broad/a.md',
          broadRootId,
          1,
          now,
          now,
          'f-narrow',
          'b.md',
          'narrow/b.md',
          narrowRootId,
          1,
          now,
          now,
        ]
      );
      const chunks: FileChunkInsert[] = [];
      const addChunk = (id: string, fileRecordId: string, index: number): void => {
        chunks.push({
          chunkIndex: index,
          chunkSize: 1,
          chunkType: 'text' as const,
          content: id,
          contentHash: `h-${id}`,
          createdAt: now,
          embedding: [1, index * 0.05, 0],
          embeddingSetId: testEmbeddingSetId,
          fileRecordId,
          id,
          tokenCount: 1,
          updatedAt: now,
        });
      };
      for (let i = 0; i < 40; i++) {
        addChunk(`broad-${i}`, 'f-broad', i);
      }
      for (let i = 0; i < 5; i++) {
        addChunk(`narrow-${i}`, 'f-narrow', i);
      }
      await repository.insertMany(chunks);
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('scopes results to a single workspace root via the rootId option', async () => {
      await seedRoutingCorpus();

      const results = await repository.searchSimilar(queryVector, {
        embeddingSetId: testEmbeddingSetId,
        limit: 50,
        rootId: narrowRootId,
        threshold: 0,
      });

      expect(results.map((r) => r.chunk.id)).toEqual([
        'narrow-0',
        'narrow-1',
        'narrow-2',
        'narrow-3',
        'narrow-4',
      ]);
    });

    it('routes a selective root scope to an exact full-precision scan (no ANN tuning)', async () => {
      await seedRoutingCorpus();
      const querySpy = vi.spyOn(client, 'query');
      const txSpy = vi.spyOn(client, 'transaction');

      const results = await repository.searchSimilar(queryVector, {
        embeddingSetId: testEmbeddingSetId,
        limit: 10,
        rootIds: [narrowRootId],
        threshold: 0,
      });

      // Exact scan: full recall of the narrow root's chunks, ranked by cosine.
      expect(results.map((r) => r.chunk.id)).toEqual([
        'narrow-0',
        'narrow-1',
        'narrow-2',
        'narrow-3',
        'narrow-4',
      ]);

      const sqls = querySpy.mock.calls.map((c) => String(c[0]));
      // Bounded selectivity counts ran...
      expect(sqls.some((s) => s.includes('COUNT(*)'))).toBe(true);
      // ...and the search ran OUTSIDE the tuned ANN transaction, ordered by the
      // full-precision vector op (which cannot match the halfvec HNSW index).
      expect(txSpy).not.toHaveBeenCalled();
      const searchSql = sqls.find((s) => s.includes('ROW_NUMBER() OVER'));
      expect(searchSql).toBeDefined();
      expect(searchSql).toContain(`::vector(${dim})`);
      expect(searchSql).not.toContain('halfvec');
    });

    it('keeps a broad root scope on the tuned ANN path', async () => {
      await seedRoutingCorpus();
      const querySpy = vi.spyOn(client, 'query');
      const txSpy = vi.spyOn(client, 'transaction');

      const results = await repository.searchSimilar(queryVector, {
        embeddingSetId: testEmbeddingSetId,
        limit: 5,
        rootIds: [broadRootId],
        threshold: 0,
      });

      expect(results.map((r) => r.chunk.id)).toEqual([
        'broad-0',
        'broad-1',
        'broad-2',
        'broad-3',
        'broad-4',
      ]);
      // Counts ran (narrowed search), but the ratio is not selective -> ANN path
      // with its transaction-scoped HNSW tuning.
      const sqls = querySpy.mock.calls.map((c) => String(c[0]));
      expect(sqls.some((s) => s.includes('COUNT(*)'))).toBe(true);
      expect(txSpy).toHaveBeenCalledTimes(1);
    });

    it('short-circuits a zero-match narrowed search to [] without searching', async () => {
      await seedRoutingCorpus();
      const querySpy = vi.spyOn(client, 'query');
      const txSpy = vi.spyOn(client, 'transaction');

      const results = await repository.searchSimilar(queryVector, {
        embeddingSetId: testEmbeddingSetId,
        limit: 10,
        rootIds: ['root-that-does-not-exist'],
        threshold: 0,
      });

      expect(results).toEqual([]);
      const sqls = querySpy.mock.calls.map((c) => String(c[0]));
      expect(sqls.some((s) => s.includes('ROW_NUMBER() OVER'))).toBe(false);
      expect(txSpy).not.toHaveBeenCalled();
    });

    it('never runs selectivity counts for un-narrowed whole-set searches', async () => {
      await seedRoutingCorpus();
      const querySpy = vi.spyOn(client, 'query');
      const txSpy = vi.spyOn(client, 'transaction');

      const results = await repository.searchSimilar(queryVector, {
        embeddingSetId: testEmbeddingSetId,
        limit: 3,
        threshold: 0,
      });

      expect(results).toHaveLength(3);
      // The dominant whole-set path pays ZERO selectivity-count overhead.
      const sqls = querySpy.mock.calls.map((c) => String(c[0]));
      expect(sqls.some((s) => s.includes('COUNT(*)'))).toBe(false);
      expect(txSpy).toHaveBeenCalledTimes(1); // tuned ANN transaction as before
    });
  });

  describe('clearEmbeddingsForSet (BST-989 slice 2 coverage)', () => {
    it('nulls embeddings for the target set only and reports the cleared count', async () => {
      await client.query(
        `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
         VALUES ('clear-set-1', 'test::clear', 'clear', 2, 'cosine', '2026-01-01T00:00:00.000Z'),
                ('keep-set-1', 'test::keep', 'keep', 2, 'cosine', '2026-01-01T00:00:00.000Z')`
      );
      const now = new Date().toISOString();
      await repository.insertMany([
        {
          chunkIndex: 0,
          content: 'clear me',
          createdAt: now,
          embedding: [0.1, 0.2],
          embeddingSetId: 'clear-set-1',
          fileRecordId: testFileRecordId,
          id: '00000000-0000-0000-0000-000000000240',
          updatedAt: now,
        },
        {
          chunkIndex: 1,
          content: 'keep me',
          createdAt: now,
          embedding: [0.3, 0.4],
          embeddingSetId: 'keep-set-1',
          fileRecordId: testFileRecordId,
          id: '00000000-0000-0000-0000-000000000241',
          updatedAt: now,
        },
      ]);

      const cleared = await repository.clearEmbeddingsForSet('clear-set-1');

      expect(cleared).toBe(1);
      const clearedRow = await client.query(
        "SELECT embedding FROM file_chunks WHERE id = '00000000-0000-0000-0000-000000000240'"
      );
      const keptRow = await client.query(
        "SELECT embedding FROM file_chunks WHERE id = '00000000-0000-0000-0000-000000000241'"
      );
      expect((clearedRow.rows[0] as { embedding: unknown }).embedding).toBeNull();
      expect((keptRow.rows[0] as { embedding: unknown }).embedding).not.toBeNull();
    });

    it('rejects an empty embeddingSetId', async () => {
      await expect(repository.clearEmbeddingsForSet('')).rejects.toThrow(
        'embeddingSetId is required'
      );
    });
  });

  describe('getStats', () => {
    it('should return statistics about chunks', async () => {
      const now = new Date().toISOString();

      await repository.insert({
        chunkIndex: 0,
        chunkType: 'code',
        content: 'code chunk',
        createdAt: now,
        embedding: [0.1, 0.2, 0.3],
        embeddingSetId: testEmbeddingSetId,
        fileRecordId: testFileRecordId,
        id: '00000000-0000-0000-0000-000000000010',
        tokenCount: 10,
        updatedAt: now,
      });

      await repository.insert({
        chunkIndex: 1,
        chunkType: 'text',
        content: 'text chunk',
        createdAt: now,
        fileRecordId: testFileRecordId,
        id: '00000000-0000-0000-0000-000000000011',
        tokenCount: 20,
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
        chunkIndex: 0,
        content: 'with embedding',
        createdAt: now,
        embedding: [0.1, 0.2, 0.3],
        embeddingSetId: testEmbeddingSetId,
        fileRecordId: testFileRecordId,
        id: '00000000-0000-0000-0000-000000000010',
        updatedAt: now,
      });

      await repository.insert({
        chunkIndex: 1,
        content: 'without embedding',
        createdAt: now,
        fileRecordId: testFileRecordId,
        id: '00000000-0000-0000-0000-000000000011',
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
          chunkIndex: 0,
          content: 'chunk 0',
          createdAt: now,
          fileRecordId: testFileRecordId,
          id: '00000000-0000-0000-0000-000000000010',
          updatedAt: now,
        },
        {
          chunkIndex: 1,
          content: 'chunk 1',
          createdAt: now,
          fileRecordId: testFileRecordId,
          id: '00000000-0000-0000-0000-000000000011',
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
          chunkIndex: 0,
          content: 'test',
          createdAt: now,
          embedding: [0.1, Number.NaN, 0.3],
          embeddingSetId: testEmbeddingSetId,
          fileRecordId: testFileRecordId,
          id: '00000000-0000-0000-0000-000000000099',
          updatedAt: now,
        })
      ).rejects.toThrow('Invalid');
    });

    it('should reject Infinity values when inserting chunk with embedding', async () => {
      const now = new Date().toISOString();
      await expect(
        repository.insert({
          chunkIndex: 0,
          content: 'test',
          createdAt: now,
          embedding: [0.1, Number.POSITIVE_INFINITY, 0.3],
          embeddingSetId: testEmbeddingSetId,
          fileRecordId: testFileRecordId,
          id: '00000000-0000-0000-0000-000000000099',
          updatedAt: now,
        })
      ).rejects.toThrow('Invalid');
    });

    it('should reject NaN values when updating chunk embedding', async () => {
      const now = new Date().toISOString();
      await repository.insert({
        chunkIndex: 0,
        content: 'test',
        createdAt: now,
        fileRecordId: testFileRecordId,
        id: '00000000-0000-0000-0000-000000000098',
        updatedAt: now,
      });

      await expect(
        repository.update({
          embedding: [0.1, Number.NaN, 0.3],
          embeddingSetId: testEmbeddingSetId,
          id: '00000000-0000-0000-0000-000000000098',
          updatedAt: new Date().toISOString(),
        })
      ).rejects.toThrow('Invalid');
    });
  });
});
