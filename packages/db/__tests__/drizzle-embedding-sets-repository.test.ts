/**
 * Drizzle EmbeddingSets Repository Tests
 *
 * Tests the Drizzle-based EmbeddingSetsRepository implementation.
 */

import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrizzleEmbeddingSetsRepository } from '../src/repositories/drizzle/embedding-sets-repository.js';
import * as schema from '../src/schema/index.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

describe('DrizzleEmbeddingSetsRepository', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  let repository: DrizzleEmbeddingSetsRepository;

  beforeEach(async () => {
    client = await createMigratedTestDb();

    // Create Drizzle instance
    db = drizzle(client, { schema });
    repository = new DrizzleEmbeddingSetsRepository(db);
  });

  afterEach(async () => {
    await client.close();
  });

  describe('getOrCreateSet', () => {
    it('should create a new embedding set', async () => {
      const result = await repository.getOrCreateSet(
        'openai::text-embedding-3-small',
        'text-embedding-3-small',
        1536,
        'cosine'
      );

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.modelKey).toBe('openai::text-embedding-3-small');
      expect(result.modelId).toBe('text-embedding-3-small');
      expect(result.dimensions).toBe(1536);
      expect(result.distance).toBe('cosine');
      expect(result.name).toBe('text-embedding-3-small (1536D)');
    });

    it('precreates the empty dimension index before returning the set', async () => {
      await repository.getOrCreateSet(
        'openai::text-embedding-3-small',
        'text-embedding-3-small',
        1536,
        'cosine'
      );

      // No caller can populate the set before its empty-table index exists.

      const indexes = await client.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE indexname = 'idx_file_chunks_emb_hnsw_1536'"
      );
      expect(indexes.rows).toHaveLength(1);
    });

    it('re-arms a lost dimension index build when an existing set is read by a fresh session', async () => {
      const created = await repository.getOrCreateSet(
        'openai::text-embedding-3-small',
        'text-embedding-3-small',
        1536,
        'cosine'
      );
      await repository.waitForPendingDimensionIndexBuilds();
      // Simulate the build lost to app quit: drop the index that was created.
      await client.exec('DROP INDEX IF EXISTS idx_file_chunks_emb_hnsw_1536');

      // Fresh repo simulates a new app session (no in-memory builder state).
      const reopened = new DrizzleEmbeddingSetsRepository(db);
      const fetched = await reopened.getById(created.id);
      expect(fetched?.dimensions).toBe(1536);

      await reopened.waitForPendingDimensionIndexBuilds();
      const indexes = await client.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE indexname = 'idx_file_chunks_emb_hnsw_1536'"
      );
      expect(indexes.rows).toHaveLength(1);
    });

    it('seeds a zero-count indexing stats row for new empty sets', async () => {
      const result = await repository.getOrCreateSet(
        'openai::text-embedding-3-small',
        'text-embedding-3-small',
        1536,
        'cosine'
      );

      const stats = await client.query<{
        chunk_count: number;
        dirty: boolean;
        embedded_chunk_count: number;
        file_count: number;
        pending_chunk_count: number;
      }>(
        `SELECT file_count, chunk_count, embedded_chunk_count, pending_chunk_count, dirty
           FROM collection_indexing_stats
          WHERE embedding_set_id = $1`,
        [result.id]
      );

      expect(stats.rows[0]).toEqual({
        chunk_count: 0,
        dirty: false,
        embedded_chunk_count: 0,
        file_count: 0,
        pending_chunk_count: 0,
      });
    });

    it('should create with custom metadata', async () => {
      const result = await repository.getOrCreateSet(
        'voyage::voyage-2',
        'voyage-2',
        1024,
        'cosine',
        {
          category: 'testing',
          description: 'Test description',
          name: 'My Custom Set',
          tags: 'test,voyage',
        }
      );

      expect(result.name).toBe('My Custom Set');
      expect(result.description).toBe('Test description');
      expect(result.tags).toBe('test,voyage');
      expect(result.category).toBe('testing');
    });

    it('should always create a new set (no dedupe)', async () => {
      const first = await repository.getOrCreateSet(
        'openai::text-embedding-3-small',
        'text-embedding-3-small',
        1536,
        'cosine'
      );
      const second = await repository.getOrCreateSet(
        'openai::text-embedding-3-small',
        'text-embedding-3-small',
        1536,
        'cosine'
      );

      expect(first.id).not.toBe(second.id);
    });

    it('should create one protected workspace index set', async () => {
      const first = await repository.getOrCreateWorkspaceIndexSet();
      const second = await repository.getOrCreateWorkspaceIndexSet();

      expect(second.id).toBe(first.id);
      expect(first).toMatchObject({
        description: 'System-managed workspace index for assistant retrieval.',
        dimensions: 384,
        distance: 'cosine',
        modelId: 'Xenova/all-MiniLM-L6-v2',
        modelKey: 'local::Xenova/all-MiniLM-L6-v2',
        name: 'Workspace Index',
        systemRole: 'workspace-index',
      });
    });

    it.each(['workspace', 'collection'] as const)(
      'rejects an empty-table %s precreate failure instead of scheduling silent recovery',
      async (kind) => {
        const originalExec = client.exec.bind(client);
        const error = new Error('fixture empty-index precreate failure');
        const exec = vi.spyOn(client, 'exec').mockImplementation(async (sql: string) => {
          if (sql.startsWith('DO $precreate_dimension_index$')) {
            throw error;
          }
          return originalExec(sql);
        });
        await expect(
          kind === 'workspace'
            ? repository.getOrCreateWorkspaceIndexSet()
            : repository.getOrCreateSet(
                'openai::text-embedding-3-small',
                'text-embedding-3-small',
                1536,
                'cosine'
              )
        ).rejects.toBe(error);
        await repository.waitForPendingDimensionIndexBuilds();
        expect(exec.mock.calls.some(([sql]) => sql.trimStart().startsWith('CREATE INDEX'))).toBe(
          false
        );
        expect((await client.query('SELECT COUNT(*)::int AS count FROM file_chunks')).rows).toEqual(
          [{ count: 0 }]
        );
        exec.mockRestore();
        if (kind === 'workspace') {
          await expect(repository.getOrCreateWorkspaceIndexSet()).resolves.toMatchObject({
            systemRole: 'workspace-index',
          });
        }
      }
    );

    it('keeps populated-table bootstrap usable when deferred dimension index creation fails', async () => {
      await client.exec(
        "INSERT INTO file_records (id, name, path, size) VALUES ('occupied-file', 'occupied', 'occupied', 1); INSERT INTO file_chunks (id, file_record_id, chunk_index, content) VALUES ('occupied-chunk', 'occupied-file', 0, 'occupied'); DROP INDEX IF EXISTS idx_file_chunks_emb_hnsw_384"
      );
      const originalExec = client.exec.bind(client);
      const exec = vi.spyOn(client, 'exec').mockImplementation(async (sql: string) => {
        if (sql.trimStart().startsWith('CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_384')) {
          throw new Error('transient index creation failure');
        }
        return await originalExec(sql);
      });

      const created = await repository.getOrCreateWorkspaceIndexSet();

      expect(created.systemRole).toBe('workspace-index');
      await expect(repository.getById(created.id)).resolves.toEqual(
        expect.objectContaining({ id: created.id })
      );
      // The build dispatch is deferred off the creation flow; drain it before
      // asserting the (failing) CREATE INDEX was attempted.
      await repository.waitForPendingDimensionIndexBuilds();
      expect(exec).toHaveBeenCalledWith(
        expect.stringContaining('CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_384')
      );
      exec.mockRestore();
    });

    it('falls back to the protected workspace index row when insert loses a unique-index race', async () => {
      type EmbeddingSetRow = typeof schema.embeddingSets.$inferSelect;
      const workspaceIndexRow: EmbeddingSetRow = {
        category: null,
        createdAt: new Date('2026-06-07T00:00:00.000Z'),
        description: 'System-managed workspace index for assistant retrieval.',
        dimensions: 384,
        distance: 'cosine',
        id: 'workspace-index-set',
        modelId: 'Xenova/all-MiniLM-L6-v2',
        modelKey: 'local::Xenova/all-MiniLM-L6-v2',
        name: 'Workspace Index',
        systemRole: 'workspace-index',
        tags: null,
      };
      let selectCalls = 0;
      const selectLimit = vi.fn(async () => {
        selectCalls += 1;
        return selectCalls === 1 ? [] : [workspaceIndexRow];
      });
      const select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: selectLimit,
          })),
        })),
      }));
      const embeddingInsertReturning = vi.fn(async () => []);
      const embeddingInsertValues = vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: embeddingInsertReturning,
        })),
      }));
      const statsOnConflictDoNothing = vi.fn(async () => undefined);
      const statsInsertValues = vi.fn(() => ({
        onConflictDoNothing: statsOnConflictDoNothing,
      }));
      const tx = {
        insert: vi.fn((table: unknown) =>
          table === schema.embeddingSets
            ? { values: embeddingInsertValues }
            : { values: statsInsertValues }
        ),
        select,
      };
      const dbWithRacingInsert = {
        $client: {
          exec: vi.fn(async () => undefined),
          query: vi.fn(async () => ({ rows: [] })),
        },
        execute: vi.fn(async () => ({ rows: [] })),
        transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx)
        ),
      };
      const racingRepository = new DrizzleEmbeddingSetsRepository(dbWithRacingInsert as never);

      const result = await racingRepository.getOrCreateWorkspaceIndexSet();

      expect(result.id).toBe('workspace-index-set');
      expect(result.systemRole).toBe('workspace-index');
      expect(embeddingInsertReturning).toHaveBeenCalled();
      expect(selectLimit).toHaveBeenCalledTimes(2);
      expect(statsInsertValues).toHaveBeenCalledWith({ embeddingSetId: 'workspace-index-set' });
    });
  });

  describe('listEmbeddingSpaces', () => {
    it('lists spaces newest-first without stats by default', async () => {
      const older = await repository.getOrCreateSet(
        'openai::text-embedding-3-small',
        'text-embedding-3-small',
        1536,
        'cosine'
      );
      const newer = await repository.getOrCreateSet(
        'ollama::nomic-embed-text',
        'nomic-embed-text',
        768,
        'cosine'
      );
      // getOrCreateSet timestamps can land in the same millisecond; force a
      // strict ordering so the ORDER BY created_at DESC contract is actually
      // exercised rather than passing on insertion luck.
      // created_at is TEXT (ISO strings; lexicographic order === chronological
      // for this format), so force the ordering with an explicit older stamp.
      await client.query(
        "UPDATE embedding_sets SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = $1",
        [older.id]
      );

      const listings = await repository.listEmbeddingSpaces();

      const olderIndex = listings.findIndex((listing) => listing.id === older.id);
      const newerIndex = listings.findIndex((listing) => listing.id === newer.id);
      expect(olderIndex).toBeGreaterThanOrEqual(0);
      expect(newerIndex).toBeGreaterThanOrEqual(0);
      expect(newerIndex).toBeLessThan(olderIndex);
      for (const listing of listings) {
        expect(listing.stats).toBeUndefined();
        expect(Number.isFinite(listing.dimensions)).toBe(true);
      }
    });

    it('computes real chunk statistics when requested', async () => {
      const created = await repository.getOrCreateSet(
        'openai::text-embedding-3-small',
        'text-embedding-3-small',
        1536,
        'cosine'
      );
      // Seed one file with two chunks (one embedded, both token-counted):
      // all-zero stats are indistinguishable from the stats CTE not running
      // at all (readOptionalFiniteNumber(undefined) -> 0), so only non-zero
      // figures prove the join executed.
      await client.query(
        `INSERT INTO file_records (id, name, path, embedding_set_id, size)
         VALUES ('esl-file-1', 'a.ts', '/w/a.ts', $1, 10)`,
        [created.id]
      );
      await client.query(
        `INSERT INTO file_chunks (id, file_record_id, embedding_set_id, chunk_index, content, token_count, embedding)
         VALUES
           ('esl-chunk-1', 'esl-file-1', $1, 0, 'alpha', 7, NULL),
           ('esl-chunk-2', 'esl-file-1', $1, 1, 'beta', 5, NULL)`,
        [created.id]
      );

      const listings = await repository.listEmbeddingSpaces({ includeStats: true });
      const listing = listings.find((entry) => entry.id === created.id);

      expect(listing?.stats).toEqual({
        averageTokensPerChunk: 6,
        embeddedChunks: 0,
        fileCount: 1,
        tokenizedChunkCount: 2,
        totalChunks: 2,
        totalTokens: 12,
      });
    });
  });

  describe('getById', () => {
    it('should find set by id', async () => {
      const created = await repository.getOrCreateSet(
        'openai::text-embedding-3-small',
        'text-embedding-3-small',
        1536,
        'cosine'
      );

      const found = await repository.getById(created.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(found?.modelKey).toBe('openai::text-embedding-3-small');
    });

    it('should return null for non-existent id', async () => {
      const found = await repository.getById('00000000-0000-0000-0000-000000000000');

      expect(found).toBeNull();
    });
  });

  describe('getByModelKey', () => {
    it('should find sets by model key', async () => {
      await repository.getOrCreateSet(
        'openai::text-embedding-3-small',
        'text-embedding-3-small',
        1536,
        'cosine'
      );
      await repository.getOrCreateSet(
        'openai::text-embedding-3-large',
        'text-embedding-3-large',
        3072,
        'cosine'
      );
      await repository.getOrCreateSet('voyage::voyage-2', 'voyage-2', 1024, 'cosine');

      const openaiSets = await repository.getByModelKey('openai::text-embedding-3-small');

      expect(openaiSets).toHaveLength(1);
      expect(openaiSets.every((s) => s.modelKey === 'openai::text-embedding-3-small')).toBe(true);
    });

    it('should return empty array for unknown model key', async () => {
      const sets = await repository.getByModelKey('unknown');

      expect(sets).toHaveLength(0);
    });
  });

  describe('updateMetadata', () => {
    it('should update metadata fields', async () => {
      const created = await repository.getOrCreateSet(
        'openai::text-embedding-3-small',
        'text-embedding-3-small',
        1536,
        'cosine'
      );

      const updated = await repository.updateMetadata(created.id, {
        description: 'Updated description',
        name: 'Updated Name',
      });

      expect(updated).toBeDefined();
      expect(updated?.name).toBe('Updated Name');
      expect(updated?.description).toBe('Updated description');
    });

    it('should return null for non-existent id', async () => {
      const result = await repository.updateMetadata('00000000-0000-0000-0000-000000000000', {
        name: 'Test',
      });

      expect(result).toBeNull();
    });
  });

  describe('findAll', () => {
    it('should return all embedding sets', async () => {
      await repository.getOrCreateSet(
        'openai::text-embedding-3-small',
        'text-embedding-3-small',
        1536,
        'cosine'
      );
      await repository.getOrCreateSet('voyage::voyage-2', 'voyage-2', 1024, 'cosine');

      const all = await repository.findAll();

      expect(all).toHaveLength(2);
    });
  });

  describe('delete', () => {
    it('should delete set by id', async () => {
      const created = await repository.getOrCreateSet(
        'openai::text-embedding-3-small',
        'text-embedding-3-small',
        1536,
        'cosine'
      );

      const deleted = await repository.delete(created.id);

      expect(deleted).toBe(true);

      const found = await repository.getById(created.id);
      expect(found).toBeNull();
    });

    it('should return false for non-existent id', async () => {
      const deleted = await repository.delete('00000000-0000-0000-0000-000000000000');

      expect(deleted).toBe(false);
    });

    it('repairs legacy malformed metadata using the model registry', async () => {
      const seededModel = await client.query<{ id: string; provider_id: string }>(
        "SELECT id, provider_id FROM models WHERE id = 'Xenova/all-MiniLM-L6-v2'"
      );
      expect(seededModel.rows[0]).toEqual({
        id: 'Xenova/all-MiniLM-L6-v2',
        provider_id: 'local',
      });

      await client.query(
        `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
         VALUES ('00000000-0000-0000-0000-000000000999', 'Xenova/all-MiniLM-L6-v2', 'all-MiniLM-L6-v2', 384, 'cosine', CURRENT_TIMESTAMP)`
      );

      const found = await repository.getById('00000000-0000-0000-0000-000000000999');

      expect(found).toMatchObject({
        id: '00000000-0000-0000-0000-000000000999',
        modelId: 'Xenova/all-MiniLM-L6-v2',
        modelKey: 'local::Xenova/all-MiniLM-L6-v2',
      });

      const repaired = await client.query<{ model_id: string; model_key: string }>(
        'SELECT model_key, model_id FROM embedding_sets WHERE id = $1',
        ['00000000-0000-0000-0000-000000000999']
      );
      expect(repaired.rows[0]).toEqual({
        model_id: 'Xenova/all-MiniLM-L6-v2',
        model_key: 'local::Xenova/all-MiniLM-L6-v2',
      });
    });
  });
});
