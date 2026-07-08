import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { JobQueue } from '../src/queue/job-queue.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('JobQueue', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://job-queue-tests');
    await migrate(db);
  });

  it('enqueues and claims a job', async () => {
    const queue = new JobQueue(db);
    const job = await queue.enqueue({
      jobType: 'embed_chunk',
      payload: { chunkId: 'c1' },
      queue: 'embeddings',
    });
    expect(job.id).toBeTruthy();
    expect(job.state).toBe('queued');

    const claimed = await queue.claim({ leaseMs: 5000, queue: 'embeddings' });
    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.state).toBe('running');
    expect(claimed?.leasedUntil).toBeTruthy();
  });

  it('persists chunk_id for indexed embedding-job cancellation', async () => {
    const queue = new JobQueue(db);

    const job = await queue.enqueue({
      jobType: 'embed_chunk',
      payload: { chunkId: 'chunk-indexed-write' },
      queue: 'embeddings',
    });
    expect(job.chunk_id).toBe('chunk-indexed-write');

    const result = await db.query<{ chunk_id: string | null }>(
      'SELECT chunk_id FROM job_queue WHERE id = $1',
      [job.id]
    );
    expect(result.rows).toEqual([{ chunk_id: 'chunk-indexed-write' }]);

    const claimed = await queue.claim({ leaseMs: 5000, queue: 'embeddings' });
    expect(claimed?.chunk_id).toBe('chunk-indexed-write');
  });

  it('heartbeat extends lease', async () => {
    const queue = new JobQueue(db);
    const _job = await queue.enqueue({ jobType: 'embed_chunk', payload: {}, queue: 'embeddings' });
    const claimed = await queue.claim({ leaseMs: 100, queue: 'embeddings' });
    expect(claimed).not.toBeNull();
    const leaseToken = claimed?.lease_token as string;

    expect(claimed?.leasedUntil).toBeTruthy();
    const before = claimed?.leasedUntil as string;
    const hb = await queue.heartbeat({
      extendMs: 2000,
      id: (claimed?.id as string) ?? '',
      leaseToken,
    });
    expect(hb).not.toBeNull();
    const after = hb?.leasedUntil as string;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it('complete transitions state to succeeded', async () => {
    const queue = new JobQueue(db);
    await queue.enqueue({ jobType: 'embed_chunk', payload: {}, queue: 'embeddings' });
    const claimed = await queue.claim({ leaseMs: 1000, queue: 'embeddings' });
    expect(claimed).not.toBeNull();
    const leaseToken = claimed?.lease_token as string;
    const done = await queue.complete({ id: (claimed?.id as string) ?? '', leaseToken });
    expect(done).not.toBeNull();
    expect(done?.state).toBe('succeeded');
  });

  it('fail requeues with backoff until max attempts then fails', async () => {
    const queue = new JobQueue(db, { maxAttempts: 3 });
    await queue.enqueue({ jobType: 'embed_chunk', payload: {}, queue: 'embeddings' });

    // First claim
    let c = await queue.claim({ leaseMs: 1000, queue: 'embeddings' });
    expect(c).not.toBeNull();
    let f = await queue.fail({
      error: 'boom',
      id: (c?.id as string) ?? '',
      leaseToken: (c?.lease_token as string) ?? '',
    });
    expect(f).not.toBeNull();
    expect(f?.state).toBe('queued');
    expect(f?.attempts as number).toBe(1);

    // Claim again using a future timestamp to bypass backoff scheduling
    c = await queue.claim({
      leaseMs: 1000,
      now: new Date('2100-01-01').toISOString(),
      queue: 'embeddings',
    });
    expect(c).not.toBeNull();
    f = await queue.fail({
      error: 'boom2',
      id: (c?.id as string) ?? '',
      leaseToken: (c?.lease_token as string) ?? '',
    });
    expect(f).not.toBeNull();
    expect(f?.state).toBe('queued');
    expect(f?.attempts as number).toBe(2);

    // Final claim and fail to reach max
    c = await queue.claim({
      leaseMs: 1000,
      now: new Date('2100-01-01').toISOString(),
      queue: 'embeddings',
    });
    expect(c).not.toBeNull();
    f = await queue.fail({
      error: 'boom3',
      id: (c?.id as string) ?? '',
      leaseToken: (c?.lease_token as string) ?? '',
    });
    expect(f).not.toBeNull();
    expect(f?.state).toBe('failed');
    expect(f?.attempts as number).toBe(3);
  });

  it('dedupe prevents duplicate active jobs for same key', async () => {
    const queue = new JobQueue(db);
    const one = await queue.enqueue({
      dedupeKey: 'A:SET1:HASH1',
      jobType: 'embed_chunk',
      payload: { chunkId: 'A' },
      queue: 'embeddings',
    });
    const two = await queue.enqueue({
      dedupeKey: 'A:SET1:HASH1',
      jobType: 'embed_chunk',
      payload: { chunkId: 'A' },
      queue: 'embeddings',
    });
    expect(two.id).toBe(one.id);

    // Once first succeeds, second enqueue can create a fresh job
    const claimed = await queue.claim({ leaseMs: 1000, queue: 'embeddings' });
    expect(claimed?.id).toBe(one.id);
    await queue.complete({
      id: (claimed?.id as string) ?? '',
      leaseToken: (claimed?.lease_token as string) ?? '',
    });

    const three = await queue.enqueue({
      dedupeKey: 'A:SET1:HASH1',
      jobType: 'embed_chunk',
      payload: { chunkId: 'A' },
      queue: 'embeddings',
    });
    expect(three.id).not.toBe(one.id);
  });

  it('claims different jobs for consecutive calls', async () => {
    const queue = new JobQueue(db);
    await queue.enqueue({ jobType: 'embed_chunk', payload: { chunkId: 'X' }, queue: 'embeddings' });
    await queue.enqueue({ jobType: 'embed_chunk', payload: { chunkId: 'Y' }, queue: 'embeddings' });
    const a = await queue.claim({ leaseMs: 1000, queue: 'embeddings' });
    const b = await queue.claim({ leaseMs: 1000, queue: 'embeddings' });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect((a?.id as string) ?? '').not.toBe((b?.id as string) ?? '');
  });
});
