/**
 * Drizzle EmbeddingSets Repository Tests
 *
 * Tests the Drizzle-based EmbeddingSetsRepository implementation.
 */

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { DrizzleEmbeddingSetsRepository } from '../src/repositories/drizzle/embedding-sets-repository.js';
import * as schema from '../src/schema/index.js';

describe('DrizzleEmbeddingSetsRepository', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  let repository: DrizzleEmbeddingSetsRepository;

  beforeEach(async () => {
    client = new PGlite({
      extensions: { vector, pg_trgm: pgTrgm },
    });

    // Run migrations to set up schema
    const migrationResult = await runMigrations(client);
    if (!migrationResult.success) {
      throw new Error(`Migrations failed: ${migrationResult.error}`);
    }

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

    it('builds the dimension index off the foreground path, observable via the awaitable', async () => {
      await repository.getOrCreateSet(
        'openai::text-embedding-3-small',
        'text-embedding-3-small',
        1536,
        'cosine'
      );

      // The build is deferred; draining it must materialize the HNSW index.
      await repository.waitForPendingDimensionIndexBuilds();

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
        file_count: 0,
        chunk_count: 0,
        embedded_chunk_count: 0,
        pending_chunk_count: 0,
        dirty: false,
      });
    });

    it('should create with custom metadata', async () => {
      const result = await repository.getOrCreateSet(
        'voyage::voyage-2',
        'voyage-2',
        1024,
        'cosine',
        {
          name: 'My Custom Set',
          description: 'Test description',
          tags: 'test,voyage',
          category: 'testing',
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
        name: 'Workspace Index',
        description: 'System-managed workspace index for assistant retrieval.',
        modelKey: 'local::Xenova/all-MiniLM-L6-v2',
        modelId: 'Xenova/all-MiniLM-L6-v2',
        dimensions: 384,
        distance: 'cosine',
        systemRole: 'workspace-index',
      });
    });

    it('keeps workspace index bootstrap usable when dimension index creation fails', async () => {
      const originalExec = client.exec.bind(client);
      const exec = vi.spyOn(client, 'exec').mockImplementation(async (sql: string) => {
        if (sql.includes('CREATE INDEX IF NOT EXISTS idx_file_chunks_emb_hnsw_384')) {
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
        id: 'workspace-index-set',
        modelKey: 'local::Xenova/all-MiniLM-L6-v2',
        modelId: 'Xenova/all-MiniLM-L6-v2',
        dimensions: 384,
        distance: 'cosine',
        createdAt: new Date('2026-06-07T00:00:00.000Z'),
        name: 'Workspace Index',
        description: 'System-managed workspace index for assistant retrieval.',
        tags: null,
        category: null,
        systemRole: 'workspace-index',
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
        name: 'Updated Name',
        description: 'Updated description',
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

    it('deletes direct and inherited chunks while clearing file record embedding metadata', async () => {
      const created = await repository.getOrCreateSet(
        'openai::text-embedding-3-small',
        'text-embedding-3-small',
        1536,
        'cosine'
      );
      await client.query(
        `INSERT INTO file_records (
           id,
           name,
           path,
           size,
           embedding_set_id,
           chunks_processed_at,
           chunks_count,
           chunking_strategy
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        ['file-1', 'file.md', '/file.md', 12, created.id, '2026-06-29T18:00:00.000Z', 2, 'sentence']
      );
      await client.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, embedding_set_id)
         VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)`,
        ['chunk-1', 'file-1', 0, 'hello', created.id, 'chunk-2', 'file-1', 1, 'inherited', null]
      );
      await client.query(
        `INSERT INTO job_queue (id, queue, job_type, payload, embedding_set_id)
         VALUES ('job-1', 'embedding', 'embed_chunk', '{}'::jsonb, $1)`,
        [created.id]
      );
      const transaction = vi.spyOn(db, 'transaction');

      await expect(repository.delete(created.id)).resolves.toBe(true);

      expect(transaction).toHaveBeenCalledTimes(1);
      const chunkRows = await client.query<{ id: string }>(
        'SELECT id FROM file_chunks WHERE file_record_id = $1 ORDER BY id',
        ['file-1']
      );
      expect(chunkRows.rows).toEqual([]);
      const fileRows = await client.query<{
        chunking_strategy: string | null;
        chunks_count: number | null;
        chunks_processed_at: string | null;
        embedding_set_id: string | null;
        id: string;
      }>(
        `SELECT id, embedding_set_id, chunks_processed_at, chunks_count, chunking_strategy
           FROM file_records
          WHERE id = $1`,
        ['file-1']
      );
      expect(fileRows.rows).toEqual([
        {
          chunking_strategy: null,
          chunks_count: null,
          chunks_processed_at: null,
          embedding_set_id: null,
          id: 'file-1',
        },
      ]);
      const jobRows = await client.query<{ id: string }>('SELECT id FROM job_queue WHERE id = $1', [
        'job-1',
      ]);
      expect(jobRows.rows).toEqual([]);
      const statsRows = await client.query<{ embedding_set_id: string }>(
        'SELECT embedding_set_id FROM collection_indexing_stats WHERE embedding_set_id = $1',
        [created.id]
      );
      expect(statsRows.rows).toEqual([]);
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
        modelKey: 'local::Xenova/all-MiniLM-L6-v2',
        modelId: 'Xenova/all-MiniLM-L6-v2',
      });

      const repaired = await client.query<{ model_id: string; model_key: string }>(
        'SELECT model_key, model_id FROM embedding_sets WHERE id = $1',
        ['00000000-0000-0000-0000-000000000999']
      );
      expect(repaired.rows[0]).toEqual({
        model_key: 'local::Xenova/all-MiniLM-L6-v2',
        model_id: 'Xenova/all-MiniLM-L6-v2',
      });
    });
  });
});
