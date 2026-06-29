import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addQueueTelemetryListener, type QueueTelemetryEvent } from '@brainstrike/queue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainstrikeDbExecutionClient } from '../src/architecture/brainstrike-db-client-contract.js';
import type { FileChunkInsert } from '../src/models/file-chunk.js';
import type { FileRecord } from '../src/models/file-record.js';
import type { JobRow } from '../src/queue/job-queue.js';
import { createTursoJobQueueReadModel, TursoJobQueue } from '../src/queue/turso-job-queue.js';
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
  let dbPath: string;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-turso-job-queue-runtime-'));
    dbPath = join(tempDir, 'profile.db');
    client = await createTursoOwnerClient({ dbPath });
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
    const events: QueueTelemetryEvent[] = [];
    const unsubscribe = addQueueTelemetryListener((event) => {
      events.push(event);
    });
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
    unsubscribe();
    expect(failed).toMatchObject({ id: job.id, state: 'queued', attempts: 1 });
    expect(failed?.lease_token).toBeNull();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'error',
          taskId: job.id,
          errorMessage: 'model unavailable',
          metadata: expect.objectContaining({
            retryAt: failed?.runAt,
          }),
        }),
      ])
    );

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
    const events: QueueTelemetryEvent[] = [];
    const unsubscribe = addQueueTelemetryListener((event) => {
      events.push(event);
    });
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
    unsubscribe();

    expect(completed.map((job) => job.id)).toEqual([owned.id]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          elapsedMs: expect.any(Number),
          event: 'complete',
          taskId: owned.id,
        }),
      ])
    );
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

  it('writes a duplicate chunk embedding once while completing every owned duplicate job', async () => {
    const first = await queue.enqueue({
      queue: 'embeddings',
      jobType: 'embed_chunk',
      payload: { chunkId: 'chunk-1', embeddingSetId },
      runAt: '2026-06-23T08:00:00.000Z',
    });
    const second = await queue.enqueue({
      queue: 'embeddings',
      jobType: 'embed_chunk',
      payload: { chunkId: 'chunk-1', embeddingSetId },
      runAt: '2026-06-23T08:00:00.000Z',
    });
    const claimed = await queue.claimMany({
      queue: 'embeddings',
      workerId: 'worker-a',
      leaseMs: 10_000,
      limit: 2,
      now: '2026-06-23T09:00:00.000Z',
    });
    const leaseById = new Map(claimed.map((job) => [job.id, job.lease_token ?? '']));
    const embeddingByJobId = new Map([
      [first.id, [0.1, 0.2, 0.3] as const],
      [second.id, [0.9, 0.8, 0.7] as const],
    ]);
    const expectedWinnerId = [first.id, second.id].sort()[0] ?? first.id;

    const completed = await queue.completeEmbeddingChunkBatch([
      {
        id: second.id,
        leaseToken: leaseById.get(second.id) ?? '',
        chunkId: 'chunk-1',
        embedding: [...(embeddingByJobId.get(second.id) ?? [])],
        embeddingHash: `embedding-hash-${second.id}`,
        embeddingSetId,
      },
      {
        id: first.id,
        leaseToken: leaseById.get(first.id) ?? '',
        chunkId: 'chunk-1',
        embedding: [...(embeddingByJobId.get(first.id) ?? [])],
        embeddingHash: `embedding-hash-${first.id}`,
        embeddingSetId,
      },
    ]);

    expect(completed.map((job) => job.id).sort()).toEqual([first.id, second.id].sort());
    await expect(chunkRepository.findById('chunk-1')).resolves.toMatchObject({
      embedding: embeddingByJobId.get(expectedWinnerId),
      embeddingHash: `embedding-hash-${expectedWinnerId}`,
      embeddingSetId,
    });
  });

  it('reports terminal failure telemetry with explicit terminal metadata', async () => {
    const events: QueueTelemetryEvent[] = [];
    const unsubscribe = addQueueTelemetryListener((event) => {
      events.push(event);
    });
    const job = await queue.enqueue({
      queue: 'embeddings',
      jobType: 'embed_chunk',
      payload: { chunkId: 'chunk-1', embeddingSetId },
    });
    const claimed = await queue.claim({
      queue: 'embeddings',
      workerId: 'worker-a',
      leaseMs: 1000,
    });
    if (!claimed) {
      throw new Error('Expected job to be claimed.');
    }

    await queue.fail({
      id: job.id,
      leaseToken: claimed.lease_token ?? '',
      error: 'permanent failure',
      terminal: true,
    });
    unsubscribe();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'error',
          taskId: job.id,
          errorMessage: 'permanent failure',
          metadata: expect.objectContaining({
            terminal: true,
          }),
        }),
      ])
    );
  });

  it('retries transient Turso write contention transactionally while completing job batches', async () => {
    const firstJob = createJobRow({
      id: 'job-complete-retry-a',
      lease_token: 'lease-complete-a',
      state: 'succeeded',
    });
    const secondJob = createJobRow({
      id: 'job-complete-retry-b',
      lease_token: 'lease-complete-b',
      state: 'succeeded',
    });
    const query = vi
      .fn<BrainstrikeDbExecutionClient['query']>()
      .mockResolvedValueOnce({ rows: [firstJob] })
      .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
      .mockResolvedValueOnce({ rows: [firstJob] })
      .mockResolvedValueOnce({ rows: [secondJob] });
    const retryQueue = new TursoJobQueue(createExecutionClient({ query }));

    await expect(
      retryQueue.completeBatch([
        { id: 'job-complete-retry-a', leaseToken: 'lease-complete-a' },
        { id: 'job-complete-retry-b', leaseToken: 'lease-complete-b' },
      ])
    ).resolves.toEqual([
      expect.objectContaining({ id: 'job-complete-retry-a', state: 'succeeded' }),
      expect.objectContaining({ id: 'job-complete-retry-b', state: 'succeeded' }),
    ]);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('retries transient Turso write contention while requeueing failed jobs', async () => {
    const runningRow = createJobRow({
      attempts: 1,
      id: 'job-fail-retry',
      lease_token: 'lease-fail',
      max_attempts: 5,
      state: 'running',
    });
    const requeuedRow = createJobRow({
      attempts: 1,
      backoff_ms: 50,
      error: 'model unavailable',
      id: 'job-fail-retry',
      lease_token: null,
      run_at: '2026-06-23T08:20:00.000Z',
      state: 'queued',
    });
    const query = vi
      .fn<BrainstrikeDbExecutionClient['query']>()
      .mockResolvedValueOnce({ rows: [runningRow] })
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockResolvedValueOnce({ rows: [runningRow] })
      .mockResolvedValueOnce({ rows: [requeuedRow] });
    const retryQueue = new TursoJobQueue(createExecutionClient({ query }));

    await expect(
      retryQueue.fail({
        backoffMs: 50,
        error: 'model unavailable',
        id: 'job-fail-retry',
        leaseToken: 'lease-fail',
      })
    ).resolves.toMatchObject({
      id: 'job-fail-retry',
      state: 'queued',
    });
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('retries transient Turso write contention while resetting failed jobs for retry', async () => {
    const query = vi
      .fn<BrainstrikeDbExecutionClient['query']>()
      .mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'))
      .mockResolvedValueOnce({ rows: [{ id: 'job-reset-retry' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'job-reset-retry' }] });
    const retryQueue = new TursoJobQueue(createExecutionClient({ query }));

    await expect(retryQueue.requeueFailed('embeddings', 1)).resolves.toBe(1);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('throws a row-scoped diagnostic for malformed job payload JSON', async () => {
    await client.exec('PRAGMA ignore_check_constraints = ON');
    await client.exec(
      `INSERT INTO job_queue (
         id,
         queue,
         job_type,
         payload,
         state,
         run_at,
         attempts,
         max_attempts,
         backoff_ms,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'bad-json-job',
        'embeddings',
        'embed_chunk',
        '{',
        'queued',
        '2026-06-23T08:00:00.000Z',
        0,
        5,
        0,
        '2026-06-23T08:00:00.000Z',
        '2026-06-23T08:00:00.000Z',
      ]
    );
    await client.exec('PRAGMA ignore_check_constraints = OFF');

    await expect(
      queue.claim({
        queue: 'embeddings',
        leaseMs: 1000,
        now: '2026-06-23T09:00:00.000Z',
      })
    ).rejects.toThrow('Invalid Turso job payload JSON for job bad-json-job');
  });

  it('claims and completes jobs across concurrent owner clients without leaking lock errors', async () => {
    const jobCount = 50;
    const workerCount = 5;
    for (let index = 0; index < jobCount; index += 1) {
      await queue.enqueue({
        queue: 'concurrent',
        jobType: 'embed_chunk',
        payload: { chunkId: `chunk-${index}`, embeddingSetId },
      });
    }
    const workerClients = await Promise.all(
      Array.from({ length: workerCount }, () => createTursoOwnerClient({ dbPath }))
    );

    try {
      const completed = new Set<string>();
      const workers = workerClients.map(async (workerClient, workerIndex) => {
        const workerQueue = new TursoJobQueue(workerClient);
        for (let attempt = 0; attempt < jobCount * 3; attempt += 1) {
          if (completed.size >= jobCount) {
            return;
          }
          const job = await workerQueue.claim({
            queue: 'concurrent',
            workerId: `worker-${workerIndex}`,
            leaseMs: 10_000,
          });
          if (!job) {
            await delay(1);
            continue;
          }
          const done = await workerQueue.complete({
            id: job.id,
            leaseToken: job.lease_token ?? '',
          });
          if (done) {
            completed.add(done.id);
          }
        }
      });

      await Promise.all(workers);

      expect(completed.size).toBe(jobCount);
      await expect(queue.getCountsByState('concurrent')).resolves.toEqual([
        { queue: 'concurrent', state: 'succeeded', count: jobCount },
      ]);
    } finally {
      await Promise.all(workerClients.map((workerClient) => workerClient.close()));
    }
  });

  it('deduplicates concurrent same-key enqueue calls across owner clients without false telemetry', async () => {
    const producerCount = 5;
    const events: QueueTelemetryEvent[] = [];
    const unsubscribe = addQueueTelemetryListener((event) => {
      events.push(event);
    });
    const producerClients = await Promise.all(
      Array.from({ length: producerCount }, () => createTursoOwnerClient({ dbPath }))
    );

    try {
      const results = await Promise.allSettled(
        producerClients.map((producerClient) =>
          new TursoJobQueue(producerClient).enqueue({
            queue: 'race',
            jobType: 'embed_chunk',
            payload: { chunkId: 'chunk-1', embeddingSetId },
            dedupeKey: `chunk-1:${embeddingSetId}:hash`,
          })
        )
      );

      expect(results.map((result) => result.status)).toEqual(
        Array.from({ length: producerCount }, () => 'fulfilled')
      );
      const jobs = results.map((result) => {
        if (result.status !== 'fulfilled') {
          throw new Error(`Expected enqueue to fulfill, got ${String(result.reason)}`);
        }
        return result.value;
      });
      expect(new Set(jobs.map((job) => job.id)).size).toBe(1);

      await expect(queue.getCountsByState('race')).resolves.toEqual([
        { queue: 'race', state: 'queued', count: 1 },
      ]);
      expect(events.filter((event) => event.event === 'enqueue')).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({
            dedupeKey: `chunk-1:${embeddingSetId}:hash`,
          }),
          taskId: jobs[0]?.id,
        }),
      ]);
    } finally {
      unsubscribe();
      await Promise.all(producerClients.map((producerClient) => producerClient.close()));
    }
  });

  it('clears selected Turso job states without touching other queues', async () => {
    await queue.enqueue({ queue: 'embeddings', jobType: 'embed_chunk', payload: {} });
    await queue.enqueue({ queue: 'other', jobType: 'embed_chunk', payload: {} });

    await expect(queue.clear('embeddings', ['queued'])).resolves.toBe(1);
    await expect(queue.getCountsByState()).resolves.toEqual([
      { queue: 'other', state: 'queued', count: 1 },
    ]);
  });

  it('reports queue counts scoped to one embedding set', async () => {
    const embeddingSetsRepository = new TursoEmbeddingSetsRepository(client);
    const otherEmbeddingSet = await embeddingSetsRepository.getOrCreateSet(
      'local::other-model',
      'other-model',
      3,
      'cosine'
    );

    await insertRawJob({
      id: 'target-queued',
      state: 'queued',
      embeddingSetId,
    });
    await insertRawJob({
      id: 'target-running',
      state: 'running',
      embeddingSetId,
    });
    await insertRawJob({
      id: 'target-failed',
      state: 'failed',
      embeddingSetId,
    });
    await insertRawJob({
      id: 'target-succeeded',
      state: 'succeeded',
      embeddingSetId,
    });
    await insertRawJob({
      id: 'other-set-queued',
      state: 'queued',
      embeddingSetId: otherEmbeddingSet.id,
    });
    await insertRawJob({
      id: 'other-queue-queued',
      queue: 'other',
      state: 'queued',
      embeddingSetId,
    });

    await expect(queue.getEmbeddingSetQueueCounts('embeddings', embeddingSetId)).resolves.toEqual({
      failed: 1,
      queued: 1,
      running: 1,
      succeeded: 1,
    });
  });

  it('reports queue metrics for recent completed and failed jobs', async () => {
    await insertRawJob({
      id: 'recent-succeeded-a',
      state: 'succeeded',
      embeddingSetId,
      runAt: '2026-06-23T08:00:00.000Z',
      updatedAt: '2026-06-23T08:01:00.000Z',
    });
    await insertRawJob({
      id: 'recent-succeeded-b',
      state: 'succeeded',
      embeddingSetId,
      runAt: '2026-06-23T08:03:00.000Z',
      updatedAt: '2026-06-23T08:03:30.000Z',
    });
    await insertRawJob({
      id: 'old-succeeded',
      state: 'succeeded',
      embeddingSetId,
      runAt: '2026-06-23T07:00:00.000Z',
      updatedAt: '2026-06-23T07:01:00.000Z',
    });
    await insertRawJob({
      id: 'other-queue-succeeded',
      queue: 'other',
      state: 'succeeded',
      embeddingSetId,
      runAt: '2026-06-23T08:02:00.000Z',
      updatedAt: '2026-06-23T08:02:10.000Z',
    });
    await insertRawJob({
      error: 'older failure',
      id: 'failed-old',
      state: 'failed',
      embeddingSetId,
      updatedAt: '2026-06-23T08:00:00.000Z',
    });
    await insertRawJob({
      error: 'newer failure',
      id: 'failed-new',
      state: 'failed',
      embeddingSetId,
      updatedAt: '2026-06-23T08:04:00.000Z',
    });

    await expect(
      queue.getQueueMetrics('embeddings', {
        latencyLimit: 1,
        since: '2026-06-23T08:00:00.000Z',
      })
    ).resolves.toEqual({
      lastError: 'newer failure',
      latencyRows: [
        {
          runAt: '2026-06-23T08:03:00.000Z',
          updatedAt: '2026-06-23T08:03:30.000Z',
        },
      ],
      throughput: 2,
    });
  });

  it('supports read-only queue metrics on query-only clients', async () => {
    await insertRawJob({
      id: 'query-only-succeeded',
      state: 'succeeded',
      embeddingSetId,
      runAt: '2026-06-23T08:00:00.000Z',
      updatedAt: '2026-06-23T08:01:00.000Z',
    });

    const queryOnlyQueue = createTursoJobQueueReadModel({
      query: <TRecord = unknown>(sql: string, params?: unknown[]) =>
        client.query<TRecord>(sql, params),
    });

    await expect(
      queryOnlyQueue.getQueueMetrics('embeddings', {
        latencyLimit: 10,
        since: '2026-06-23T08:00:00.000Z',
      })
    ).resolves.toMatchObject({
      throughput: 1,
    });
  });

  async function readJobStates(): Promise<Array<{ id: string; state: string }>> {
    const result = await client.query<{ id: string; state: string }>(
      'SELECT id, state FROM job_queue ORDER BY id'
    );
    return result.rows;
  }

  async function insertRawJob(input: {
    embeddingSetId: string;
    error?: string | null;
    id: string;
    queue?: string;
    runAt?: string;
    state: 'failed' | 'queued' | 'running' | 'succeeded';
    updatedAt?: string;
  }): Promise<void> {
    const runAt = input.runAt ?? '2026-06-23T08:20:00.000Z';
    const updatedAt = input.updatedAt ?? runAt;
    await client.exec(
      `INSERT INTO job_queue (
         id,
         queue,
         job_type,
         payload,
         chunk_id,
         embedding_set_id,
         state,
         run_at,
         attempts,
         max_attempts,
         backoff_ms,
         lease_token,
         leased_until,
         worker_id,
         dedupe_key,
         error,
         created_at,
         updated_at
       )
       VALUES (?, ?, 'embed_chunk', ?, ?, ?, ?, ?, 0, 5, 0, NULL, NULL, NULL, NULL, ?, ?, ?)`,
      [
        input.id,
        input.queue ?? 'embeddings',
        JSON.stringify({ chunkId: input.id, embeddingSetId: input.embeddingSetId }),
        input.id,
        input.embeddingSetId,
        input.state,
        runAt,
        input.error ?? null,
        updatedAt,
        updatedAt,
      ]
    );
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function createExecutionClient(overrides: {
  query: BrainstrikeDbExecutionClient['query'];
}): BrainstrikeDbExecutionClient {
  const client = {
    exec: vi.fn<BrainstrikeDbExecutionClient['exec']>(),
    query: overrides.query,
    transaction: vi.fn<BrainstrikeDbExecutionClient['transaction']>(),
  };
  client.transaction.mockImplementation(async (callback) => await callback(client));
  return {
    exec: client.exec,
    query: client.query,
    transaction: client.transaction,
  };
}

function createJobRow(overrides: Partial<JobRow> = {}): JobRow {
  return {
    attempts: 1,
    backoff_ms: 0,
    chunk_id: 'chunk-1',
    created_at: '2026-06-23T08:00:00.000Z',
    dedupe_key: null,
    embedding_set_id: 'embedding-set-1',
    error: null,
    id: 'job-1',
    job_type: 'embed_chunk',
    lease_token: 'lease-1',
    leased_until: '2026-06-23T08:10:00.000Z',
    max_attempts: 5,
    payload: JSON.stringify({ chunkId: 'chunk-1', embeddingSetId: 'embedding-set-1' }),
    queue: 'embeddings',
    run_at: '2026-06-23T08:00:00.000Z',
    state: 'running' as const,
    updated_at: '2026-06-23T08:00:00.000Z',
    worker_id: 'worker-a',
    ...overrides,
  };
}
