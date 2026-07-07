import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { JobQueue } from '../src/queue/job-queue.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('JobQueue Batch Operations', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://job-queue-batch-tests');
    await migrate(db);
  });

  it('completes multiple jobs atomically', async () => {
    const queue = new JobQueue(db);
    const job1 = await queue.enqueue({ jobType: 'embed_chunk', payload: {}, queue: 'q1' });
    const job2 = await queue.enqueue({ jobType: 'embed_chunk', payload: {}, queue: 'q1' });

    const claimed = await queue.claimMany({ leaseMs: 5000, limit: 2, queue: 'q1' });
    expect(claimed).toHaveLength(2);

    const completionParams = claimed.map((j) => ({
      id: j.id,
      leaseToken: j.lease_token as string,
    }));

    const completed = await queue.completeBatch(completionParams);
    expect(completed).toHaveLength(2);
    expect(completed.map((j) => j.id).sort()).toEqual([job1.id, job2.id].sort());
    expect(completed.every((j) => j.state === 'succeeded')).toBe(true);
  });

  it('handles empty batch gracefully', async () => {
    const queue = new JobQueue(db);
    const result = await queue.completeBatch([]);
    expect(result).toEqual([]);
  });

  it('only completes jobs with valid leases', async () => {
    const queue = new JobQueue(db);
    const job1 = await queue.enqueue({ jobType: 'embed_chunk', payload: {}, queue: 'q1' });
    const claimed = await queue.claim({ leaseMs: 5000, queue: 'q1' });
    expect(claimed).not.toBeNull();

    const result = await queue.completeBatch([
      { id: claimed!.id, leaseToken: claimed!.lease_token as string },
      { id: 'fake-id', leaseToken: 'fake-token' }, // Should be ignored
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(job1.id);
  });

  it('does not write embeddings when the completion lease is stale', async () => {
    const queue = new JobQueue(db);
    const now = new Date().toISOString();
    const embeddingSetId = 'set-stale-completion';
    const fileId = 'file-stale-completion';
    const chunkId = 'chunk-stale-completion';
    const embedding = Array.from({ length: 768 }, (_, index) => index / 1000);

    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [embeddingSetId, 'local::test-model', 'test-model', 768, 'cosine', now]
    );
    await db.query(
      `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, embedding_set_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
      [
        fileId,
        'stale-completion.ts',
        '/stale-completion.ts',
        100,
        'content',
        'stale-completion-hash',
        10,
        embeddingSetId,
        now,
      ]
    );
    await db.query(
      `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
       VALUES ($1,$2,0,$3,$4,$5,'text',10,$6,$6)`,
      [chunkId, fileId, 'content', 'stale-completion-hash', 10, now]
    );

    await queue.enqueue({
      jobType: 'embed_chunk',
      payload: { chunkId, embeddingSetId },
      queue: 'embeddings',
    });
    const claimed = await queue.claim({ leaseMs: 5000, queue: 'embeddings' });
    expect(claimed).not.toBeNull();

    const completed = await queue.completeEmbeddingChunkBatch([
      {
        chunkId,
        embedding,
        embeddingHash: 'stale-completion-embedding-hash',
        embeddingSetId,
        id: claimed!.id,
        leaseToken: 'stale-lease-token',
      },
    ]);

    expect(completed).toEqual([]);

    const chunk = await db.query<{
      embedding: string | null;
      embedding_hash: string | null;
      embedding_set_id: string | null;
    }>(
      `SELECT embedding::text AS embedding, embedding_hash, embedding_set_id
       FROM file_chunks
       WHERE id = $1`,
      [chunkId]
    );
    expect(chunk.rows[0]).toEqual({
      embedding: null,
      embedding_hash: null,
      embedding_set_id: null,
    });

    const job = await db.query<{ state: string }>('SELECT state FROM job_queue WHERE id = $1', [
      claimed!.id,
    ]);
    expect(job.rows[0]?.state).toBe('running');
  });

  describe('enqueueBatch', () => {
    it('enqueues multiple jobs', async () => {
      const queue = new JobQueue(db);
      const jobs = await queue.enqueueBatch([
        { jobType: 'embed_chunk', payload: { i: 1 }, queue: 'q1' },
        { jobType: 'embed_chunk', payload: { i: 2 }, queue: 'q1' },
      ]);
      expect(jobs).toHaveLength(2);
      expect(jobs[0].state).toBe('queued');
      expect(jobs[1].state).toBe('queued');

      const stats = await queue.getQueueStats('q1');
      expect(stats[0].queued).toBe(2);
    });

    it('persists chunk_id for batch-enqueued embedding jobs', async () => {
      const queue = new JobQueue(db);
      const jobs = await queue.enqueueBatch([
        { jobType: 'embed_chunk', payload: { chunkId: 'batch-chunk-1' }, queue: 'q1' },
        { jobType: 'embed_chunk', payload: { chunkId: 'batch-chunk-2' }, queue: 'q1' },
      ]);

      const result = await db.query<{ chunk_id: string | null }>(
        'SELECT chunk_id FROM job_queue WHERE id = ANY($1::text[]) ORDER BY chunk_id',
        [jobs.map((job) => job.id)]
      );
      expect(result.rows).toEqual([{ chunk_id: 'batch-chunk-1' }, { chunk_id: 'batch-chunk-2' }]);
    });

    it('persists embedding_set_id for batch-enqueued embedding jobs', async () => {
      const queue = new JobQueue(db);
      const jobs = await queue.enqueueBatch([
        {
          jobType: 'embed_chunk',
          payload: { chunkId: 'chunk-1', embeddingSetId: 'set-1' },
          queue: 'q1',
        },
        {
          jobType: 'embed_chunk',
          payload: { chunkId: 'chunk-2', embeddingSetId: 'set-2' },
          queue: 'q1',
        },
      ]);

      const result = await db.query<{ embedding_set_id: string | null }>(
        'SELECT embedding_set_id FROM job_queue WHERE id = ANY($1::text[]) ORDER BY embedding_set_id',
        [jobs.map((job) => job.id)]
      );
      expect(result.rows).toEqual([{ embedding_set_id: 'set-1' }, { embedding_set_id: 'set-2' }]);
    });

    it('deduplicates within batch', async () => {
      const queue = new JobQueue(db);
      const runAt1 = new Date(Date.now() + 1000).toISOString();
      const runAt2 = new Date(Date.now() + 500).toISOString();

      const jobs = await queue.enqueueBatch([
        {
          dedupeKey: 'k1',
          jobType: 'embed_chunk',
          payload: { i: 1 },
          queue: 'q1',
          runAt: runAt1,
        },
        {
          dedupeKey: 'k1',
          jobType: 'embed_chunk',
          payload: { i: 2 },
          queue: 'q1',
          runAt: runAt2,
        },
      ]);

      // Should return 1 job
      expect(jobs).toHaveLength(1);
      expect(jobs[0].dedupe_key).toBe('k1');
      // Should pick the earlier runAt (runAt2)
      expect(new Date(jobs[0].runAt).getTime()).toBe(new Date(runAt2).getTime());
    });

    it('updates existing job if deduplicated', async () => {
      const queue = new JobQueue(db);
      const job1 = await queue.enqueue({
        dedupeKey: 'k1',
        jobType: 'embed_chunk',
        payload: {},
        queue: 'q1',
      });

      const newRunAt = new Date(Date.now() - 1000).toISOString(); // Earlier
      const jobs = await queue.enqueueBatch([
        {
          dedupeKey: 'k1',
          jobType: 'embed_chunk',
          payload: { updated: true },
          queue: 'q1',
          runAt: newRunAt,
        },
      ]);

      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(job1.id);
      expect(new Date(jobs[0].runAt).getTime()).toBe(new Date(newRunAt).getTime());
      expect(jobs[0].runAt).toBe(newRunAt);
      expect(jobs[0].runAt).toContain('T');
      expect(jobs[0].runAt.endsWith('Z')).toBe(true);
    });

    it('updates existing job when UUID SQL branch is forced', async () => {
      const queue = new JobQueue(db);
      (queue as unknown as { idType: 'uuid' | 'text' | null }).idType = 'uuid';

      const existing = await queue.enqueue({
        dedupeKey: 'uuid-branch-dedupe',
        jobType: 'embed_chunk',
        payload: { before: true },
        queue: 'q1',
      });

      const earlierRunAt = new Date(Date.now() - 1000).toISOString();
      const jobs = await queue.enqueueBatch([
        {
          dedupeKey: 'uuid-branch-dedupe',
          jobType: 'embed_chunk',
          payload: { after: true },
          queue: 'q1',
          runAt: earlierRunAt,
        },
      ]);

      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(existing.id);
      expect(new Date(jobs[0].runAt).getTime()).toBe(new Date(earlierRunAt).getTime());
      expect(jobs[0].runAt).toBe(earlierRunAt);
      expect(jobs[0].runAt).toContain('T');
      expect(jobs[0].runAt.endsWith('Z')).toBe(true);
    });

    it('handles mixed new and existing jobs', async () => {
      const queue = new JobQueue(db);
      const existing = await queue.enqueue({
        dedupeKey: 'existing',
        jobType: 'embed_chunk',
        payload: {},
        queue: 'q1',
      });

      const jobs = await queue.enqueueBatch([
        { dedupeKey: 'existing', jobType: 'embed_chunk', payload: { i: 1 }, queue: 'q1' },
        { dedupeKey: 'new', jobType: 'embed_chunk', payload: { i: 2 }, queue: 'q1' },
      ]);

      expect(jobs).toHaveLength(2);
      const jobExisting = jobs.find((j) => j.dedupe_key === 'existing');
      const jobNew = jobs.find((j) => j.dedupe_key === 'new');

      expect(jobExisting?.id).toBe(existing.id);
      expect(jobNew?.id).not.toBe(existing.id);
    });

    it('does not update payload on deduplication', async () => {
      const queue = new JobQueue(db);
      const job1 = await queue.enqueue({
        dedupeKey: 'k1',
        jobType: 'embed_chunk',
        payload: { v: 1 },
        queue: 'q1',
      });

      const jobs = await queue.enqueueBatch([
        {
          dedupeKey: 'k1',
          jobType: 'embed_chunk',
          payload: { v: 2 },
          queue: 'q1',
        },
      ]);

      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(job1.id);

      const fetched = await queue.claim({ leaseMs: 1000, queue: 'q1' });
      expect(fetched).not.toBeNull();
      // Payload should remain { v: 1 } as per dedupe logic (only runAt/updatedAt updated)
      expect(fetched?.payload).toEqual({ v: 1 });
    });

    it('handles multiple queues in one batch', async () => {
      const queue = new JobQueue(db);
      const jobs = await queue.enqueueBatch([
        { jobType: 'embed_chunk', payload: { i: 1 }, queue: 'q1' },
        { jobType: 'embed_chunk', payload: { i: 2 }, queue: 'q2' },
      ]);

      expect(jobs).toHaveLength(2);
      const statsQ1 = await queue.getQueueStats('q1');
      const statsQ2 = await queue.getQueueStats('q2');

      expect(statsQ1[0].queued).toBe(1);
      expect(statsQ2[0].queued).toBe(1);
    });

    it('handles empty batch', async () => {
      const queue = new JobQueue(db);
      const jobs = await queue.enqueueBatch([]);
      expect(jobs).toEqual([]);
    });

    it('rejects batches larger than the supported maximum', async () => {
      const queue = new JobQueue(db);
      const oversizeBatch = Array.from({ length: 9001 }, (_, index) => ({
        jobType: 'embed_chunk',
        payload: { index },
        queue: 'q1',
      }));

      await expect(queue.enqueueBatch(oversizeBatch)).rejects.toThrow(
        'exceeds maximum supported size'
      );
    });
  });

  describe('failBatch', () => {
    it('fails all jobs as terminal', async () => {
      const queue = new JobQueue(db);
      await queue.enqueue({ jobType: 'embed_chunk', payload: {}, queue: 'q1' });
      await queue.enqueue({ jobType: 'embed_chunk', payload: {}, queue: 'q1' });

      const claimed = await queue.claimMany({ leaseMs: 5000, limit: 2, queue: 'q1' });
      expect(claimed).toHaveLength(2);

      const result = await queue.failBatch({
        error: 'terminal error',
        jobs: claimed.map((j) => ({ id: j.id, leaseToken: j.lease_token as string })),
        terminal: true,
      });

      expect(result).toHaveLength(2);
      expect(result.every((j) => j.state === 'failed')).toBe(true);
      expect(result.every((j) => j.error === 'terminal error')).toBe(true);
    });

    it('retries jobs that have attempts remaining', async () => {
      const queue = new JobQueue(db);
      await queue.enqueue({
        jobType: 'embed_chunk',
        maxAttempts: 5,
        payload: {},
        queue: 'q1',
      });

      const claimed = await queue.claim({ leaseMs: 5000, queue: 'q1' });
      expect(claimed).not.toBeNull();
      // After claim, attempts = 1, max_attempts = 5 → retryable

      const result = await queue.failBatch({
        error: 'transient error',
        jobs: [{ id: claimed!.id, leaseToken: claimed!.lease_token as string }],
      });

      expect(result).toHaveLength(1);
      expect(result[0].state).toBe('queued');
      expect(result[0].error).toBe('transient error');
      // run_at should be in the future
      expect(new Date(result[0].runAt).getTime()).toBeGreaterThan(Date.now() - 1000);
    });

    it('handles mixed exhausted and retryable jobs', async () => {
      const queue = new JobQueue(db);

      // Job with maxAttempts=1 will be exhausted after first claim
      await queue.enqueue({
        jobType: 'embed_chunk',
        maxAttempts: 1,
        payload: { type: 'exhausted' },
        queue: 'q1',
      });
      // Job with maxAttempts=5 will be retryable
      await queue.enqueue({
        jobType: 'embed_chunk',
        maxAttempts: 5,
        payload: { type: 'retryable' },
        queue: 'q1',
      });

      const claimed = await queue.claimMany({ leaseMs: 5000, limit: 2, queue: 'q1' });
      expect(claimed).toHaveLength(2);

      const result = await queue.failBatch({
        error: 'batch error',
        jobs: claimed.map((j) => ({ id: j.id, leaseToken: j.lease_token as string })),
      });

      expect(result).toHaveLength(2);

      const failed = result.filter((j) => j.state === 'failed');
      const retried = result.filter((j) => j.state === 'queued');

      expect(failed).toHaveLength(1);
      expect(retried).toHaveLength(1);
    });

    it('silently ignores invalid lease tokens', async () => {
      const queue = new JobQueue(db);
      await queue.enqueue({ jobType: 'embed_chunk', payload: {}, queue: 'q1' });

      const claimed = await queue.claim({ leaseMs: 5000, queue: 'q1' });
      expect(claimed).not.toBeNull();

      const result = await queue.failBatch({
        error: 'some error',
        jobs: [
          { id: claimed!.id, leaseToken: claimed!.lease_token as string },
          { id: 'fake-id', leaseToken: 'fake-token' },
        ],
        terminal: true,
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(claimed!.id);
    });

    it('returns empty array for empty batch', async () => {
      const queue = new JobQueue(db);
      const result = await queue.failBatch({
        error: 'unused',
        jobs: [],
      });
      expect(result).toEqual([]);
    });

    it('uses explicit backoffMs instead of retryPolicy', async () => {
      const queue = new JobQueue(db);
      await queue.enqueue({
        jobType: 'embed_chunk',
        maxAttempts: 5,
        payload: {},
        queue: 'q1',
      });

      const claimed = await queue.claim({ leaseMs: 5000, queue: 'q1' });
      expect(claimed).not.toBeNull();

      const beforeFail = Date.now();
      const result = await queue.failBatch({
        backoffMs: 30_000,
        error: 'rate limited',
        jobs: [{ id: claimed!.id, leaseToken: claimed!.lease_token as string }],
      });

      expect(result).toHaveLength(1);
      expect(result[0].state).toBe('queued');
      expect(result[0].backoff_ms).toBe(30_000);
      // run_at should be ~30s from now
      const runAtMs = new Date(result[0].runAt).getTime();
      expect(runAtMs).toBeGreaterThanOrEqual(beforeFail + 29_000);
      expect(runAtMs).toBeLessThanOrEqual(beforeFail + 32_000);
    });

    it('produces different per-job run_at values via jitter', async () => {
      const queue = new JobQueue(db);
      // Enqueue 3 jobs with enough max_attempts for multiple rounds
      for (let i = 0; i < 3; i++) {
        await queue.enqueue({
          jobType: 'embed_chunk',
          maxAttempts: 10,
          payload: { i },
          queue: 'q1',
        });
      }

      // Pump attempts to 3 so retryPolicy jitter range exceeds the base floor.
      // At attempts=1, jitter ∈ [400,1000] clamped to base=1000 → always 1000.
      // At attempts=3, jitter ∈ [1600,4000] → meaningful variation.
      const futureNow = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      for (let round = 0; round < 2; round++) {
        const batch = await queue.claimMany({
          leaseMs: 5000,
          limit: 3,
          now: futureNow,
          queue: 'q1',
        });
        await Promise.all(
          batch.map((j) =>
            queue.fail({ error: 'bump', id: j.id, leaseToken: j.lease_token as string })
          )
        );
      }

      // Now attempts=3 for all jobs; claim and failBatch
      const claimed = await queue.claimMany({
        leaseMs: 5000,
        limit: 3,
        now: futureNow,
        queue: 'q1',
      });
      expect(claimed).toHaveLength(3);

      const result = await queue.failBatch({
        error: 'transient',
        jobs: claimed.map((j) => ({ id: j.id, leaseToken: j.lease_token as string })),
      });

      expect(result).toHaveLength(3);
      expect(result.every((j) => j.state === 'queued')).toBe(true);

      // With jitter at attempts=3, at least 2 of 3 run_at values should differ
      const runAts = result.map((j) => j.runAt);
      const uniqueRunAts = new Set(runAts);
      expect(uniqueRunAts.size).toBeGreaterThanOrEqual(2);
    });
  });
});
