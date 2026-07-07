import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import { JobQueue } from '../src/queue/job-queue.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('JobQueue concurrency claim behavior', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://job-queue-concurrency');
    await migrate(db);
  });

  it('only one claimant gets the single available job', async () => {
    const jq = new JobQueue(db);
    await jq.enqueue({ jobType: 'embed_chunk', payload: {}, queue: 'embeddings' });
    const [a, b] = await Promise.all([
      jq.claim({ leaseMs: 5000, queue: 'embeddings' }),
      jq.claim({ leaseMs: 5000, queue: 'embeddings' }),
    ]);
    const results = [a, b].filter(Boolean);
    expect(results).toHaveLength(1);
  });
});
