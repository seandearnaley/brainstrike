import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileChunkInsert } from '../src/models/file-chunk.js';
import type { FileRecord } from '../src/models/file-record.js';
import { TursoJobQueue } from '../src/queue/turso-job-queue.js';
import { TursoEmbeddingSetsRepository } from '../src/repositories/turso-embedding-sets-repository.js';
import { TursoFileChunkRepository } from '../src/repositories/turso-file-chunk-repository.js';
import { TursoFileRecordRepository } from '../src/repositories/turso-file-record-repository.js';
import { createTursoOwnerClient, type TursoOwnerClient } from '../src/turso/owner-client.js';
import { applyTursoSchemaBaseline } from '../src/turso/schema-baseline.js';

describe('TursoJobQueue runtime operations', () => {
  let chunkRepository: TursoFileChunkRepository;
  let client: TursoOwnerClient;
  let embeddingSetId: string;
  let queue: TursoJobQueue;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-turso-job-queue-runtime-'));
    client = await createTursoOwnerClient({ dbPath: join(tempDir, 'profile.db') });
    await applyTursoSchemaBaseline(client);
    const embeddingSetsRepository = new TursoEmbeddingSetsRepository(client);
    const fileRecordsRepository = new TursoFileRecordRepository(client);
    chunkRepository = new TursoFileChunkRepository(client);
    queue = new TursoJobQueue(client);
    const embeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'local::test-model',
      'test-model',
      3,
      'cosine'
    );
    embeddingSetId = embeddingSet.id;
    await fileRecordsRepository.createWithContent(createRecord({ embeddingSetId }));
    await chunkRepository.insert(createChunk({ embeddingSetId }));
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { force: true, recursive: true });
  });

  it('claims queued jobs, heartbeats leases, retries failures, and reports queue stats', async () => {
    const job = await queue.enqueue({
      queue: 'embeddings',
      jobType: 'embed_chunk',
      payload: { chunkId: 'chunk-1', embeddingSetId },
      dedupeKey: `chunk-1:${embeddingSetId}:hash-chunk-1`,
      runAt: '2026-06-23T08:00:00.000Z',
    });

    expect(job.state).toBe('queued');
    expect(job.chunk_id).toBe('chunk-1');
    expect(job.embedding_set_id).toBe(embeddingSetId);

    const [claimed] = await queue.claimMany({
      queue: 'embeddings',
      workerId: 'worker-a',
      leaseMs: 1000,
      now: '2026-06-23T09:00:00.000Z',
      limit: 2,
    });

    expect(claimed).toMatchObject({
      id: job.id,
      state: 'running',
      attempts: 1,
      worker_id: 'worker-a',
    });

    const heartbeat = await queue.heartbeat({
      id: job.id,
      leaseToken: claimed.lease_token ?? '',
      extendMs: 10_000,
    });
    expect(heartbeat?.id).toBe(job.id);
    expect(heartbeat?.leasedUntil).toBeTruthy();

    const failed = await queue.fail({
      id: job.id,
      leaseToken: claimed.lease_token ?? '',
      error: 'model unavailable',
      backoffMs: 50,
    });
    expect(failed).toMatchObject({ id: job.id, state: 'queued', attempts: 1 });
    expect(failed?.lease_token).toBeNull();

    const stats = await queue.getQueueStats('embeddings');
    expect(stats).toEqual([
      expect.objectContaining({
        queue: 'embeddings',
        queued: 1,
        running: 0,
        failed: 0,
        succeeded: 0,
      }),
    ]);
  });

  it('writes chunk embeddings and completes jobs only for owned leases', async () => {
    const owned = await queue.enqueue({
      queue: 'embeddings',
      jobType: 'embed_chunk',
      payload: { chunkId: 'chunk-1', embeddingSetId },
    });
    const stale = await queue.enqueue({
      queue: 'embeddings',
      jobType: 'embed_chunk',
      payload: { chunkId: 'chunk-1', embeddingSetId },
    });
    const [ownedClaim, staleClaim] = await queue.claimMany({
      queue: 'embeddings',
      workerId: 'worker-a',
      leaseMs: 10_000,
      limit: 2,
    });

    await client.exec('UPDATE job_queue SET lease_token = ? WHERE id = ?', [
      'stolen-token',
      stale.id,
    ]);

    const completed = await queue.completeEmbeddingChunkBatch([
      {
        id: owned.id,
        leaseToken: ownedClaim.lease_token ?? '',
        chunkId: 'chunk-1',
        embedding: [0.1, 0.2, 0.3],
        embeddingHash: 'embedding-hash-owned',
        embeddingSetId,
      },
      {
        id: stale.id,
        leaseToken: staleClaim.lease_token ?? '',
        chunkId: 'chunk-1',
        embedding: [0.9, 0.8, 0.7],
        embeddingHash: 'embedding-hash-stale',
        embeddingSetId,
      },
    ]);

    expect(completed.map((job) => job.id)).toEqual([owned.id]);
    await expect(chunkRepository.findById('chunk-1')).resolves.toMatchObject({
      embedding: [0.1, 0.2, 0.3],
      embeddingHash: 'embedding-hash-owned',
      embeddingSetId,
    });
    const jobStates = await readJobStates();
    expect(jobStates).toHaveLength(2);
    expect(jobStates).toEqual(
      expect.arrayContaining([
        { id: owned.id, state: 'succeeded' },
        { id: stale.id, state: 'running' },
      ])
    );
  });

  it('clears selected Turso job states without touching other queues', async () => {
    await queue.enqueue({ queue: 'embeddings', jobType: 'embed_chunk', payload: {} });
    await queue.enqueue({ queue: 'other', jobType: 'embed_chunk', payload: {} });

    await expect(queue.clear('embeddings', ['queued'])).resolves.toBe(1);
    await expect(queue.getCountsByState()).resolves.toEqual([
      { queue: 'other', state: 'queued', count: 1 },
    ]);
  });

  async function readJobStates(): Promise<Array<{ id: string; state: string }>> {
    const result = await client.query<{ id: string; state: string }>(
      'SELECT id, state FROM job_queue ORDER BY id'
    );
    return result.rows;
  }
});

function createRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    content: 'const answer = 42;',
    contentHash: 'hash-file-1',
    createdAt: '2026-06-23T08:00:00.000Z',
    embeddingSetId: null,
    id: 'file-1',
    name: 'index.ts',
    path: 'src/index.ts',
    size: 42,
    tokenCount: 8,
    updatedAt: '2026-06-23T08:00:00.000Z',
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
    createdAt: '2026-06-23T08:10:00.000Z',
    fileRecordId: 'file-1',
    id: 'chunk-1',
    tokenCount: 4,
    updatedAt: '2026-06-23T08:10:00.000Z',
    ...overrides,
  };
}
