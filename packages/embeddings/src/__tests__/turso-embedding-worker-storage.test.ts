import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FileChunkInsert,
  type FileRecord,
  TursoEmbeddingSetsRepository,
  TursoFileChunkRepository,
  TursoFileRecordRepository,
  TursoJobQueue,
} from '@brainstrike/db';
import { createTursoOwnerClient, type TursoOwnerClient } from '@brainstrike/db/turso/owner-client';
import { applyTursoSchemaBaseline } from '@brainstrike/db/turso/schema-baseline';
import { DEFAULT_EMBEDDING_DIMENSION } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTursoEmbeddingWorkerStorage } from '../worker/embedding-worker-storage';

describe('Turso embedding worker storage', () => {
  let chunkRepository: TursoFileChunkRepository;
  let client: TursoOwnerClient;
  let queue: TursoJobQueue;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-turso-embedding-worker-storage-'));
    client = await createTursoOwnerClient({ dbPath: join(tempDir, 'profile.db') });
    await applyTursoSchemaBaseline(client);
    chunkRepository = new TursoFileChunkRepository(client);
    queue = new TursoJobQueue(client);
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { force: true, recursive: true });
  });

  it('adapts a Turso owner client to the embedding worker storage contract', async () => {
    const embeddingSetsRepository = new TursoEmbeddingSetsRepository(client);
    const fileRecordsRepository = new TursoFileRecordRepository(client);
    const embeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'local::test-model',
      'test-model',
      3,
      'cosine'
    );
    await fileRecordsRepository.createWithContent(
      createRecord({ embeddingSetId: embeddingSet.id })
    );
    await chunkRepository.insert(createChunk({ embeddingSetId: embeddingSet.id }));
    const setupJob = await queue.enqueue({
      queue: 'embeddings',
      jobType: 'embed_chunk',
      payload: { chunkId: 'chunk-1', embeddingSetId: embeddingSet.id },
      runAt: '2026-06-30T08:00:00.000Z',
    });

    const storage = createTursoEmbeddingWorkerStorage(client);
    await expect(storage.assertEmbeddingStorageReady()).resolves.toBeUndefined();

    await expect(storage.getModelConfig('Xenova/all-MiniLM-L6-v2')).resolves.toMatchObject({
      dimensions: 384,
      id: 'Xenova/all-MiniLM-L6-v2',
      origin: 'local',
    });
    await client.exec(
      `INSERT INTO models (
         id,
         provider_id,
         name,
         description,
         is_enabled,
         capabilities,
         parameters,
         sort_order
       )
         VALUES (?, 'local', 'Non-object local embedder', 'non-object metadata fixture', 1, ?, ?, 999)`,
      ['local::non-object-embedder', '[]', '"not-an-object"']
    );
    await expect(storage.getModelConfig('local::non-object-embedder')).resolves.toMatchObject({
      dimensions: DEFAULT_EMBEDDING_DIMENSION,
      id: 'local::non-object-embedder',
      origin: 'local',
    });
    await expect(storage.resolveEmbeddingSetDimension(embeddingSet.id)).resolves.toBe(3);
    await expect(storage.loadChunksByIds(['chunk-1'])).resolves.toEqual([
      {
        content: 'const answer = 42;',
        contentHash: 'hash-chunk-1',
        embeddingHash: null,
        embeddingSetId: embeddingSet.id,
        id: 'chunk-1',
      },
    ]);

    const claimed = await storage.queue.claimMany({
      queue: 'embeddings',
      workerId: 'worker-a',
      leaseMs: 10_000,
      limit: 1,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: setupJob.id,
      lease_token: expect.any(String),
      state: 'running',
    });

    const completed = await storage.queue.completeEmbeddingChunkBatch([
      {
        id: setupJob.id,
        leaseToken: claimed[0]?.lease_token ?? '',
        chunkId: 'chunk-1',
        embedding: [0.1, 0.2, 0.3],
        embeddingHash: 'embedding-hash-1',
        embeddingSetId: embeddingSet.id,
      },
    ]);
    expect(completed).toHaveLength(1);
    await expect(chunkRepository.findById('chunk-1')).resolves.toMatchObject({
      embedding: [0.1, 0.2, 0.3],
      embeddingHash: 'embedding-hash-1',
      embeddingSetId: embeddingSet.id,
    });

    const log = vi.fn();
    const stats = storage.createStatsRefreshController({
      completedChunkThreshold: 1,
      log,
      minIntervalMs: 60_000,
      now: () => 1000,
    });
    await stats.recordCompletions([embeddingSet.id], 1);
    await expect(readStatsRow(client, embeddingSet.id)).resolves.toMatchObject({ dirty: 1 });

    await stats.flush('queue-idle');

    await expect(readStatsRow(client, embeddingSet.id)).resolves.toMatchObject({
      chunk_count: 1,
      dirty: 0,
      embedded_chunk_count: 1,
      file_count: 1,
      pending_chunk_count: 0,
    });
    expect(log).toHaveBeenCalledWith(
      'embedding_stats_refresh',
      expect.objectContaining({
        completedChunkCount: 1,
        embeddingSetCount: 1,
        reason: 'queue-idle',
      })
    );
  });
});

function createRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    content: 'const answer = 42;',
    contentHash: 'hash-file-1',
    createdAt: '2026-06-30T07:50:00.000Z',
    id: 'file-1',
    name: 'index.ts',
    path: 'src/index.ts',
    size: 42,
    tokenCount: 8,
    updatedAt: '2026-06-30T07:50:00.000Z',
    ...overrides,
  };
}

function createChunk(overrides: Partial<FileChunkInsert> = {}): FileChunkInsert {
  return {
    chunkIndex: 0,
    chunkSize: 18,
    chunkType: 'code',
    content: 'const answer = 42;',
    contentHash: 'hash-chunk-1',
    createdAt: '2026-06-30T07:55:00.000Z',
    fileRecordId: 'file-1',
    id: 'chunk-1',
    tokenCount: 4,
    updatedAt: '2026-06-30T07:55:00.000Z',
    ...overrides,
  };
}

async function readStatsRow(client: TursoOwnerClient, embeddingSetId: string) {
  const result = await client.query<{
    chunk_count: number | string;
    dirty: number | string;
    embedded_chunk_count: number | string;
    file_count: number | string;
    pending_chunk_count: number | string;
  }>(
    `SELECT file_count, chunk_count, embedded_chunk_count, pending_chunk_count, dirty
       FROM collection_indexing_stats
      WHERE embedding_set_id = ?`,
    [embeddingSetId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    chunk_count: Number(row.chunk_count),
    dirty: Number(row.dirty),
    embedded_chunk_count: Number(row.embedded_chunk_count),
    file_count: Number(row.file_count),
    pending_chunk_count: Number(row.pending_chunk_count),
  };
}
