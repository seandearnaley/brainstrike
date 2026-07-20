import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { JobQueue } from '../src/queue/job-queue.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

describe('JobQueue concurrency claim behavior', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
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
